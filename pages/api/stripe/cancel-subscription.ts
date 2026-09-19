import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import {
  getSubscriptionsByStripeId,
  updateSubscriptionStatus,
} from "@/utils/db/db-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildCancelSubscriptionProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "stripe-cancel-subscription", RATE_LIMIT))
  )
    return;

  try {
    const { subscriptionId, connectedAccountId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({ error: "Subscription ID is required" });
    }

    // A multi-seller recurring cart stores ONE row per recurring item under
    // the same Stripe subscription id — ownership is ANY row's buyer/seller.
    const dbSubscriptions = await getSubscriptionsByStripeId(subscriptionId);
    if (dbSubscriptions.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const signedEvent = extractSignedEventFromRequest(req);
    const verification = verifySignedHttpRequestProof(
      signedEvent,
      buildCancelSubscriptionProof({
        pubkey: signedEvent?.pubkey || "",
        subscriptionId,
      })
    );
    if (!verification.ok) {
      return res
        .status(verification.status)
        .json({ error: verification.error });
    }
    const callerPubkey = signedEvent!.pubkey;
    // Cancel acts on the WHOLE Stripe subscription. When one subscription
    // holds items from multiple independent sellers, letting any one seller
    // cancel would cancel every other seller's items too — whole-
    // subscription mutations are buyer-only. Single-seller subscriptions
    // keep seller access.
    const distinctSellers = new Set(
      dbSubscriptions.map((row: any) => row.seller_pubkey)
    );
    const isBuyer = dbSubscriptions.some(
      (row: any) => row.buyer_pubkey === callerPubkey
    );
    const ownsSubscription =
      isBuyer ||
      (distinctSellers.size === 1 &&
        dbSubscriptions.some(
          (row: any) => row.seller_pubkey === callerPubkey
        ));
    if (!ownsSubscription) {
      return res
        .status(403)
        .json({ error: "You do not own this subscription" });
    }

    // Prefer the Connect account recorded on the subscription at creation
    // time; a seller who reconnects a different Stripe account would
    // otherwise target the wrong account and orphan this subscription.
    // Fall back to the caller-supplied account for legacy rows.
    const targetAccountId =
      (dbSubscriptions.find((row: any) => row.connected_account_id) as any)
        ?.connected_account_id || connectedAccountId;
    const stripeOptions = targetAccountId
      ? { stripeAccount: targetAccountId }
      : undefined;

    const canceledSubscription = await stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      stripeOptions
    );

    await updateSubscriptionStatus(subscriptionId, "canceled");

    const canceledData = canceledSubscription as any;
    return res.status(200).json({
      success: true,
      subscriptionId: canceledData.id,
      status: canceledData.status,
      cancelAtPeriodEnd: canceledData.cancel_at_period_end,
      currentPeriodEnd: canceledData.current_period_end,
    });
  } catch (error) {
    console.error("Stripe subscription cancellation error:", error);
    return res.status(500).json({
      error: "Failed to cancel subscription",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
