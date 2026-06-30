import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { applyRateLimit } from "@/utils/rate-limit";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { runAutoLabelPurchase } from "@/utils/shipping/auto-purchase";
import type { ShippingAddressInput } from "@/utils/shipping/types";

// Web (Stripe) card path for automatic shipping-label purchase.
//
// The buyer's browser fires this once per seller after a successful card
// payment. We re-verify the PaymentIntent against Stripe (it must be
// `succeeded` and name this seller in its metadata) before letting the shared
// core buy a label on the SELLER's own Shippo account. The buyer address is
// passed transiently in the body and is never persisted beyond the label
// record the seller needs to ship. No Nostr proof is required; authorization
// comes from the verified, settled payment.

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

interface AutoPurchaseBody {
  paymentIntentId: string;
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
  if (!(await applyRateLimit(req, res, "shipping-auto-purchase", RATE_LIMIT))) {
    return;
  }
  if (!isShippoOAuthConfigured()) {
    return res.status(200).json({ success: false, skipped: true });
  }

  try {
    const { paymentIntentId, orderId, sellerPubkey, productId, toAddress } =
      (req.body || {}) as Partial<AutoPurchaseBody>;

    if (
      !paymentIntentId ||
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

    // Re-verify the payment against Stripe. Single-seller direct charges live on
    // the seller's connected account; multi-merchant charges live on the
    // platform account — try the connected account first, then fall back.
    let pi: Stripe.PaymentIntent | null = null;
    const connect = await getStripeConnectAccount(sellerPubkey);
    if (connect?.stripe_account_id) {
      try {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
          stripeAccount: connect.stripe_account_id,
        });
      } catch {
        // Not on the connected account — fall through to the platform account.
      }
    }
    if (!pi) {
      try {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch {
        pi = null;
      }
    }

    if (!pi) {
      return res.status(200).json({ success: false, reason: "pi-not-found" });
    }
    if (pi.status !== "succeeded") {
      return res
        .status(200)
        .json({ success: false, reason: "pi-not-succeeded" });
    }
    // The settled payment must name this seller, so a buyer can only ever cause
    // a label to be bought on the account of a seller they actually paid.
    const metaSellers = (pi.metadata?.sellerPubkey || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!metaSellers.includes(sellerPubkey)) {
      return res
        .status(200)
        .json({ success: false, reason: "seller-mismatch" });
    }

    const result = await runAutoLabelPurchase({
      sellerPubkey,
      orderId,
      // Dedupe on the VERIFIED PaymentIntent id, not the client-supplied
      // orderId: the buyer's browser generates orderId, so keying the claim on
      // it would let one settled PI be replayed with fresh orderIds to buy
      // unlimited seller-billed labels. pi.id is Stripe-bound and one-per-charge.
      claimRef: pi.id,
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
    console.error("shipping/auto-purchase failed:", message);
    return res.status(200).json({ success: false, reason: "error" });
  }
}
