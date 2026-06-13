import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import {
  isCrypto,
  toSmallestUnit,
  satsToUSD,
  ZERO_DECIMAL_CURRENCIES,
} from "@/utils/stripe/currency";
import { applyRateLimit } from "@/utils/rate-limit";
import { withStripeRetry } from "@/utils/stripe/retry-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

const RATE_LIMIT = { limit: 60, windowMs: 60000 };

interface ShippingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "stripe-calculate-tax", RATE_LIMIT)) return;

  try {
    const {
      amount,
      currency,
      shippingAddress,
      sellerPubkey,
      isMultiMerchant,
    }: {
      amount: number;
      currency: string;
      shippingAddress: ShippingAddress;
      sellerPubkey?: string;
      isMultiMerchant?: boolean;
    } = req.body;

    if (
      !amount ||
      !currency ||
      !shippingAddress ||
      !shippingAddress.country ||
      !shippingAddress.postal_code
    ) {
      return res
        .status(400)
        .json({ error: "Missing amount, currency, or shipping address" });
    }

    let amountInSmallestUnit: number;
    let stripeCurrency: string;

    if (isCrypto(currency)) {
      const sats =
        currency.toLowerCase() === "btc" ? amount * 100000000 : amount;
      const usdAmount = await satsToUSD(sats);
      amountInSmallestUnit = Math.ceil(usdAmount * 100);
      stripeCurrency = "usd";
    } else {
      amountInSmallestUnit = toSmallestUnit(amount, currency);
      stripeCurrency = currency.toLowerCase();
    }

    // Sales tax is opt-in per seller and only supported on single-seller
    // (direct-charge) checkouts in v1. Multi-merchant carts skip tax entirely:
    // a single platform-level calculation can't honor each seller's separate
    // nexus/registrations, and the tax couldn't be attributed per transfer.
    const skipResponse = {
      success: true,
      taxAmountSmallest: 0,
      totalSmallest: amountInSmallestUnit,
      currency: stripeCurrency,
      skipped: true,
    };

    if (isMultiMerchant || !sellerPubkey) {
      return res.status(200).json(skipResponse);
    }

    const connectAccount = await getStripeConnectAccount(sellerPubkey);
    if (
      !connectAccount ||
      !connectAccount.charges_enabled ||
      !connectAccount.tax_enabled
    ) {
      // Seller hasn't connected Stripe, finished onboarding, or turned on tax.
      return res.status(200).json(skipResponse);
    }

    const stripeOptions: Stripe.RequestOptions = {
      stripeAccount: connectAccount.stripe_account_id,
    };

    let calculation: Stripe.Tax.Calculation;
    try {
      calculation = await withStripeRetry(() =>
        stripe.tax.calculations.create(
          {
            currency: stripeCurrency,
            line_items: [
              {
                amount: amountInSmallestUnit,
                reference: "cart_total",
                tax_behavior: "exclusive",
              },
            ],
            customer_details: {
              address: {
                line1: shippingAddress.line1 || undefined,
                line2: shippingAddress.line2 || undefined,
                city: shippingAddress.city || undefined,
                state: shippingAddress.state || undefined,
                postal_code: shippingAddress.postal_code!,
                country: shippingAddress.country!,
              },
              address_source: "shipping",
            },
          },
          stripeOptions
        )
      );
    } catch (err: any) {
      // Stripe Tax not enabled / no nexus / unsupported region — treat as zero tax.
      const code = err?.code || err?.raw?.code;
      const param = err?.param || err?.raw?.param;
      console.warn("Tax calculation skipped:", code || err?.message, param);
      return res.status(200).json({
        success: true,
        taxAmountSmallest: 0,
        totalSmallest: amountInSmallestUnit,
        currency: stripeCurrency,
        skipped: true,
      });
    }

    const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(stripeCurrency);
    const taxAmountSmallest = calculation.tax_amount_exclusive ?? 0;
    const totalSmallest = calculation.amount_total ?? amountInSmallestUnit;

    return res.status(200).json({
      success: true,
      calculationId: calculation.id,
      taxAmountSmallest,
      totalSmallest,
      currency: stripeCurrency,
      isZeroDecimal,
    });
  } catch (error) {
    console.error("Tax calculation error:", error);
    return res.status(500).json({
      error: "Failed to calculate tax",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
