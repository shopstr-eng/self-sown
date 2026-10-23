import type { NextApiRequest, NextApiResponse } from "next";
import {
  getSubscriptionsByBuyerPubkey,
  getSubscriptionsByBuyerEmail,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildListSubscriptionsProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 120, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "stripe-get-subscriptions", RATE_LIMIT)))
    return;

  try {
    const { pubkey, email, subscriptionId } = req.query;

    if (!pubkey && !email) {
      return res
        .status(400)
        .json({ error: "Either pubkey or email query parameter is required" });
    }

    let subscriptions;

    if (pubkey && typeof pubkey === "string") {
      // Rows include the buyer's shipping address and other PII, so reading by
      // pubkey requires the same signed Nostr proof as cancel/update. The
      // queried pubkey is the proof's pubkey, so the verifier itself enforces
      // that the caller owns the identity being read.
      const signedEvent = extractSignedEventFromRequest(req);
      const verification = verifySignedHttpRequestProof(
        signedEvent,
        buildListSubscriptionsProof(pubkey)
      );
      if (!verification.ok) {
        return res
          .status(verification.status)
          .json({ error: verification.error });
      }
      subscriptions = await getSubscriptionsByBuyerPubkey(pubkey);
    } else if (email && typeof email === "string") {
      // Guests have no Nostr key to sign with, so the email lookup needs a
      // different capability: the Stripe subscription id from the buyer's
      // receipt (unguessable) must be supplied and match server-side. The
      // sequential integer row id is deliberately NOT accepted.
      if (typeof subscriptionId !== "string" || subscriptionId === "") {
        return res.status(400).json({
          error: "A subscriptionId is required to look up by email",
        });
      }
      const rows = await getSubscriptionsByBuyerEmail(email);
      subscriptions = rows.filter(
        (row) => row.stripe_subscription_id === subscriptionId
      );
    } else {
      return res.status(400).json({ error: "Invalid query parameters" });
    }

    return res.status(200).json({
      success: true,
      subscriptions,
    });
  } catch (error) {
    console.error("Failed to fetch subscriptions:", error);
    return res.status(500).json({
      error: "Failed to fetch subscriptions",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
