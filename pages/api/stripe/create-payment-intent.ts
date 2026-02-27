import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { fiat } from "@getalby/lightning-tools";
import { getStripeConnectAccount } from "@/utils/db/db-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

const satsToUSD = async (sats: number): Promise<number> => {
  try {
    const usdAmount = await fiat.getFiatValue({
      satoshi: sats,
      currency: "usd",
    });
    return usdAmount;
  } catch (error) {
    console.error("Error converting sats to USD:", error);
    const btcPrice = 100000;
    return (sats / 100000000) * btcPrice;
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      amount,
      currency,
      customerEmail,
      productTitle,
      productDescription,
      metadata,
    } = req.body;

    let amountInCents: number;
    const currencyLower = currency.toLowerCase();

    if (currencyLower === "sats" || currencyLower === "sat") {
      const usdAmount = await satsToUSD(amount);
      amountInCents = Math.round(usdAmount * 100);
    } else if (currencyLower === "btc") {
      const sats = amount * 100000000;
      const usdAmount = await satsToUSD(sats);
      amountInCents = Math.round(usdAmount * 100);
    } else if (currencyLower === "usd") {
      amountInCents = Math.round(amount * 100);
    } else {
      amountInCents = Math.round(amount * 100);
    }

    if (amountInCents < 50) {
      amountInCents = 50;
    }

    const sellerPubkey = metadata?.sellerPubkey;
    let connectedAccountId: string | null = null;

    if (sellerPubkey) {
      const isPlatformAccount =
        sellerPubkey === process.env.NEXT_PUBLIC_MILK_MARKET_PK;

      if (!isPlatformAccount) {
        const connectAccount = await getStripeConnectAccount(sellerPubkey);
        if (connectAccount && connectAccount.charges_enabled) {
          connectedAccountId = connectAccount.stripe_account_id;
        }
      }
    }

    const stripeOptions = connectedAccountId
      ? { stripeAccount: connectedAccountId }
      : undefined;

    const description = `${productTitle}${
      productDescription ? ` - ${productDescription}` : ""
    }`;

    const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountInCents,
      currency: "usd",
      description,
      metadata: {
        ...metadata,
        originalAmount: amount.toString(),
        originalCurrency: currency,
        ...(connectedAccountId && { connectedAccountId }),
      },
      automatic_payment_methods: {
        enabled: true,
      },
    };

    if (customerEmail) {
      paymentIntentParams.receipt_email = customerEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentParams,
      stripeOptions
    );

    return res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      connectedAccountId: connectedAccountId || undefined,
    });
  } catch (error) {
    console.error("Stripe PaymentIntent creation error:", error);
    return res.status(500).json({
      error: "Failed to create payment intent",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
