import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { isSquareConfigured } from "@/utils/square/square-config";
import {
  getValidSquareAccessToken,
  getSquarePayment,
} from "@/utils/square/square-api";
import { runAutoLabelPurchase } from "@/utils/shipping/auto-purchase";
import type { ShippingAddressInput } from "@/utils/shipping/types";

// Web (Square) card path for automatic shipping-label purchase. Mirrors the
// Stripe endpoint (pages/api/shipping/auto-purchase.ts) for sellers charging on
// their own Square account.
//
// The buyer's browser fires this once after a successful Square card payment. We
// re-verify the payment against Square using the SELLER's own access token
// before letting the shared core buy a label on the seller's own Shippo account.
// Retrieving the payment with the seller's token is what binds the payment to
// that seller (a payment id from another account 404s), and we require status
// `COMPLETED` (autocomplete charges; APPROVED funds are only authorized). No
// Nostr proof is required; authorization comes from the verified, settled
// payment. Square is single-seller only, so there is no multi-merchant path.

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

interface AutoPurchaseSquareBody {
  squarePaymentId: string;
  orderId: string;
  sellerPubkey: string;
  productId: string;
  toAddress: ShippingAddressInput;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(
      req,
      res,
      "shipping-auto-purchase-square",
      RATE_LIMIT
    ))
  ) {
    return;
  }
  if (!isShippoOAuthConfigured() || !isSquareConfigured()) {
    return res.status(200).json({ success: false, skipped: true });
  }

  try {
    const { squarePaymentId, orderId, sellerPubkey, productId, toAddress } =
      (req.body || {}) as Partial<AutoPurchaseSquareBody>;

    if (
      !squarePaymentId ||
      !orderId ||
      !sellerPubkey ||
      !productId ||
      !toAddress?.street1 ||
      !toAddress?.city ||
      !toAddress?.state ||
      !toAddress?.zip ||
      !toAddress?.country
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Resolve the seller's Square connection server-side. Retrieving the payment
    // with THIS seller's access token binds the payment to the seller — a buyer
    // can only ever cause a label to be bought on the account of a seller they
    // actually paid through their own Square connection.
    const access = await getValidSquareAccessToken(sellerPubkey);
    if (!access) {
      return res.status(200).json({ success: false, reason: "no-square" });
    }

    const payment = await getSquarePayment(access.accessToken, squarePaymentId);
    if (!payment) {
      return res
        .status(200)
        .json({ success: false, reason: "payment-not-found" });
    }
    // autocomplete charges settle as COMPLETED; APPROVED means the funds are
    // only authorized (never captured here), so do not buy a label against them.
    if (payment.status !== "COMPLETED") {
      return res
        .status(200)
        .json({ success: false, reason: "payment-not-completed" });
    }

    const result = await runAutoLabelPurchase({
      sellerPubkey,
      orderId,
      // Dedupe on the VERIFIED Square payment id, not the client-supplied
      // orderId: the buyer's browser generates orderId, so keying the claim on
      // it would let one settled payment be replayed with fresh orderIds to buy
      // unlimited seller-billed labels. payment.id is Square-bound and
      // one-per-charge.
      claimRef: payment.id,
      productId,
      toAddress: {
        name: toAddress.name,
        street1: toAddress.street1,
        street2: toAddress.street2,
        city: toAddress.city,
        state: toAddress.state,
        zip: toAddress.zip,
        country: toAddress.country,
        email: toAddress.email,
      },
    });

    return res.status(200).json({
      success: result.purchased,
      reason: result.reason,
      labelId: result.labelId ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("shipping/auto-purchase-square failed:", message);
    return res.status(200).json({ success: false, reason: "error" });
  }
}
