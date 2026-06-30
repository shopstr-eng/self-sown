import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  isCrypto,
  toSmallestUnit,
  satsToUSD,
  isExchangeRateError,
  EXCHANGE_RATE_ERROR_CODE,
} from "@/utils/stripe/currency";
import { stableIdempotencyKey } from "@/utils/stripe/retry-service";
import {
  getValidSquareAccessToken,
  createSquarePayment,
} from "@/utils/square/square-api";
import { isSquareConfigured } from "@/utils/square/square-config";

// Buyer/guest-facing card charge on a SINGLE seller's own Square account.
//
// Security model (mirrors stripe/create-payment-intent): unauthenticated and
// rate limited. The server resolves the seller's Square connection, location and
// settlement currency from the DB and IGNORES any client-supplied token or
// location. Only the card nonce (sourceId) and the buyer-facing amount/currency
// come from the client; the amount is validated against the seller's location
// currency before charging. Square is single-seller only — multi-seller carts
// are never card-eligible here (the cart keeps those on Stripe).
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "square-create-payment", RATE_LIMIT)))
    return;

  try {
    // Fail closed when Square isn't configured for this deployment.
    if (!isSquareConfigured()) {
      return res.status(503).json({
        error: "Square is not available",
        code: "square_unconfigured",
      });
    }

    const {
      sourceId,
      amount,
      currency,
      sellerPubkey,
      customerEmail,
      productTitle,
      metadata,
    } = req.body;

    if (!sourceId || typeof sourceId !== "string") {
      return res.status(400).json({ error: "Missing card payment token" });
    }
    if (!sellerPubkey || typeof sellerPubkey !== "string") {
      return res.status(400).json({ error: "Missing seller" });
    }
    if (typeof amount !== "number" || !(amount > 0)) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!currency || typeof currency !== "string") {
      return res.status(400).json({ error: "Invalid currency" });
    }

    // Resolve the seller's Square connection server-side. Never trust a
    // client-supplied access token or location id.
    const access = await getValidSquareAccessToken(sellerPubkey);
    if (!access) {
      return res.status(400).json({
        error: "Seller does not have Square enabled",
        code: "square_not_connected",
      });
    }
    if (!access.locationId) {
      return res
        .status(400)
        .json({ error: "Seller Square location unavailable" });
    }
    const locationCurrency = (access.locationCurrency || "").toUpperCase();
    if (!locationCurrency) {
      return res
        .status(400)
        .json({ error: "Seller Square currency unavailable" });
    }

    // Currency guard + conversion to the smallest unit in the LOCATION currency.
    // Crypto (sats/BTC) is only chargeable when the location settles in USD.
    let amountSmallest: number;
    let chargeCurrency: string;
    if (isCrypto(currency)) {
      if (locationCurrency !== "USD") {
        return res.status(400).json({
          error: "This seller can't accept Bitcoin on card",
          code: "currency_mismatch",
        });
      }
      const sats =
        currency.toLowerCase() === "btc" ? amount * 100000000 : amount;
      const usdAmount = await satsToUSD(sats);
      amountSmallest = Math.ceil(usdAmount * 100);
      chargeCurrency = "USD";
    } else {
      if (currency.toUpperCase() !== locationCurrency) {
        return res.status(400).json({
          error: "Currency not supported by this seller",
          code: "currency_mismatch",
        });
      }
      amountSmallest = toSmallestUnit(amount, currency);
      chargeCurrency = locationCurrency;
    }

    if (amountSmallest < 1) amountSmallest = 1;

    // Stable idempotency key derived from the charge inputs: identical across
    // resubmits/retries of the SAME checkout attempt, so Square dedups a
    // double-tap into one charge. (Square caps the key at 45 chars; this is 35.)
    const idempotencyKey = stableIdempotencyKey("sq", {
      sellerPubkey,
      amountSmallest,
      chargeCurrency,
      customerEmail:
        typeof customerEmail === "string" ? customerEmail.trim() : null,
      productTitle: typeof productTitle === "string" ? productTitle : null,
      metadata: metadata ?? null,
    });

    let buyerEmailAddress: string | undefined;
    if (typeof customerEmail === "string") {
      const trimmed = customerEmail.trim();
      if (EMAIL_RE.test(trimmed)) buyerEmailAddress = trimmed;
    }

    const referenceId =
      metadata && typeof metadata.orderId === "string"
        ? metadata.orderId
        : undefined;

    const payment = await createSquarePayment(access.accessToken, {
      sourceId,
      idempotencyKey,
      amount: amountSmallest,
      currency: chargeCurrency,
      locationId: access.locationId,
      note: typeof productTitle === "string" ? productTitle : undefined,
      buyerEmailAddress,
      referenceId,
    });

    // autocomplete:true means a successful charge settles as COMPLETED. APPROVED
    // means the funds are only authorized and still need a separate capture,
    // which we never request — so treat anything other than COMPLETED as a
    // failure rather than confirming an order against uncaptured funds.
    if (payment.status !== "COMPLETED") {
      return res.status(402).json({
        error: "Payment was not completed",
        status: payment.status,
      });
    }

    return res.status(200).json({
      success: true,
      paymentId: payment.id,
      status: payment.status,
    });
  } catch (error) {
    console.error("Square payment creation error:", error);
    const rateError = isExchangeRateError(error);
    return res.status(rateError ? 503 : 500).json({
      error: "Failed to process Square payment",
      ...(rateError && { code: EXCHANGE_RATE_ERROR_CODE }),
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
