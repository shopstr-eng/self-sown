import type { NextApiRequest, NextApiResponse } from "next";
import {
  getStripeConnectAccount,
  disconnectStripeConnectAccount,
} from "@/utils/db/db-service";
import { buildStripeDisconnectProof } from "@/utils/mcp/request-proof";
import {
  extractSignedEventFromRequest,
  verifyAndConsumeSignedRequestProof,
} from "@/utils/mcp/request-proof-server";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { applyRateLimit } from "@/utils/rate-limit";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

// Disconnects (unlinks) the seller's Stripe Connect account from Milk Market so
// they can connect a different one. This removes the link from our database
// only; the Stripe account itself is left untouched (it may still hold a balance
// or pending payouts), and the seller manages or closes it from Stripe directly.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "stripe-connect-disconnect", RATE_LIMIT))
    return;

  try {
    const { pubkey } = req.body || {};

    if (!pubkey || typeof pubkey !== "string" || !pubkey.trim()) {
      return res.status(400).json({ error: "pubkey is required" });
    }
    const normalizedPubkey = pubkey.trim();

    const signedEvent = extractSignedEventFromRequest(req);
    const proofResult = await verifyAndConsumeSignedRequestProof(
      signedEvent,
      buildStripeDisconnectProof(normalizedPubkey)
    );

    if (!proofResult.ok) {
      const authResult = verifyNostrAuth(
        signedEvent,
        normalizedPubkey,
        "stripe-connect",
        { method: "POST", path: "/api/stripe/connect/disconnect" }
      );
      if (!authResult.valid) {
        return res.status(proofResult.status).json({
          error:
            proofResult.error || authResult.error || "Authentication failed",
        });
      }
    }

    const existing = await getStripeConnectAccount(normalizedPubkey);
    if (!existing || !existing.stripe_account_id) {
      // Nothing linked — treat as already disconnected so the UI lands in the
      // "no account connected" state either way.
      return res
        .status(200)
        .json({ disconnected: true, alreadyDisconnected: true });
    }

    await disconnectStripeConnectAccount(normalizedPubkey);

    return res.status(200).json({ disconnected: true });
  } catch (error) {
    console.error("Stripe Connect disconnect error:", error);
    return res.status(500).json({
      error: "Failed to disconnect Stripe account",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
