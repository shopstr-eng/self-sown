import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes } from "crypto";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildSquareOAuthStartProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { buildSquareAuthorizeUrl } from "@/utils/square/square-oauth";
import {
  getSquareRedirectUri,
  isSquareConfigured,
} from "@/utils/square/square-config";
import { createSquareOAuthState } from "@/utils/db/square-service";
import { getStripeConnectAccount } from "@/utils/db/db-service";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "square-oauth-start", RATE_LIMIT)))
    return;
  if (!isSquareConfigured()) {
    return res.status(503).json({ error: "Square is not configured" });
  }

  try {
    const { pubkey, signedEvent, app } = (req.body || {}) as {
      pubkey?: string;
      signedEvent?: unknown;
      // Mobile app flows set this so the redirect page bounces back into the
      // app scheme instead of the web settings page. It only selects between
      // fixed safe targets, so it is not bound into the signed proof.
      app?: boolean;
    };
    if (!pubkey) {
      return res.status(400).json({ error: "pubkey is required" });
    }

    const headerValue = req.headers[MCP_SIGNED_EVENT_HEADER];
    const normalizedHeader = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    const event =
      (signedEvent as Parameters<
        typeof verifyAndConsumeSignedRequestProof
      >[0]) ||
      (typeof normalizedHeader === "string"
        ? (parseSignedEventHeader(normalizedHeader) ?? undefined)
        : undefined);

    const verification = await verifyAndConsumeSignedRequestProof(
      event,
      buildSquareOAuthStartProof(pubkey)
    );
    if (!verification.ok) {
      // Mobile app clients sign a NIP-98-style seller-action event instead of
      // the MCP request proof (same fallback the Stripe connect routes use).
      const nostrAuth = verifyNostrAuth(event, pubkey, "square-oauth", {
        method: "POST",
        path: "/api/square/oauth/start",
      });
      if (!nostrAuth.valid) {
        return res
          .status(verification.status)
          .json({ error: verification.error || nostrAuth.error });
      }
    }

    // Bidirectional XOR: a seller uses EITHER Stripe OR Square, never both.
    // Refuse to start a Square connection while a Stripe Connect account exists.
    const stripe = await getStripeConnectAccount(pubkey);
    if (stripe && stripe.stripe_account_id) {
      return res.status(409).json({
        error:
          "Stripe is already connected. Disconnect Stripe before connecting Square.",
        code: "stripe_connected",
      });
    }

    // App flows carry an "app_" prefix in the state so the redirect page
    // bounces back into the app scheme. The state is stored verbatim and
    // matched exactly when consumed, so the prefix can't be forged or
    // stripped without invalidating the flow.
    const state = `${app === true ? "app_" : ""}${randomBytes(24).toString("hex")}`;
    // Pin the authorize-time redirect URI so the token exchange still matches
    // if the base domain flips mid-flow (the callback page 301s to the new
    // domain, but Square requires the original URI).
    await createSquareOAuthState(pubkey, state, getSquareRedirectUri());
    const authorizeUrl = buildSquareAuthorizeUrl(state);

    return res.status(200).json({ success: true, authorizeUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Square OAuth start failed:", message);
    return res.status(500).json({ error: message });
  }
}
