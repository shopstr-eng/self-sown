import type { NextApiRequest, NextApiResponse } from "next";
import {
  getStripeConnectClientId,
  getStandardConnectRedirectUri,
  isStandardConnectConfigured,
} from "@/utils/stripe/connect-config";
import { createOAuthState } from "@/utils/stripe/standard-oauth";
import { buildStripeStandardStartProof } from "@/utils/mcp/request-proof";
import {
  extractSignedEventFromRequest,
  verifyAndConsumeSignedRequestProof,
} from "@/utils/mcp/request-proof-server";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { applyRateLimit } from "@/utils/rate-limit";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 60, windowMs: 60000 };

/**
 * Starts the Stripe Standard Connect OAuth flow. Returns the authorize URL
 * the seller opens to link (or create) their own full Stripe account.
 *
 * Unlike Express accounts (platform-hosted, created via the API), a Standard
 * account belongs to the seller: onboarding, verification, and bank details
 * all happen on Stripe's side, and the seller keeps their full Stripe
 * Dashboard. We only learn the account id when the OAuth callback completes.
 */
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
      "stripe-connect-standard-start",
      RATE_LIMIT
    ))
  )
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
      buildStripeStandardStartProof(normalizedPubkey)
    );

    if (!proofResult.ok) {
      const authResult = verifyNostrAuth(
        signedEvent,
        normalizedPubkey,
        "stripe-connect",
        { method: "POST", path: "/api/stripe/connect/standard/start" }
      );
      if (!authResult.valid) {
        return res.status(proofResult.status).json({
          error:
            proofResult.error || authResult.error || "Authentication failed",
        });
      }
    }

    // Fail closed: without the platform's Connect client id the OAuth URL
    // would just error at Stripe.
    if (!isStandardConnectConfigured()) {
      return res.status(503).json({
        error: "Standard Connect isn't enabled on this deployment yet",
        code: "standard_connect_not_configured",
      });
    }

    // The state binds the (unauthenticated) OAuth callback back to this
    // seller — see utils/stripe/standard-oauth.ts.
    const state = createOAuthState(normalizedPubkey);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: getStripeConnectClientId(),
      scope: "read_write",
      redirect_uri: getStandardConnectRedirectUri(),
      state,
    });

    return res.status(200).json({
      url: `https://connect.stripe.com/oauth/authorize?${params.toString()}`,
    });
  } catch (error) {
    console.error("Stripe Standard Connect start error:", error);
    return res.status(500).json({
      error: "Failed to start Stripe connection",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
