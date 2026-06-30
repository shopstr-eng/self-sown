import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes } from "crypto";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildSquareOAuthStartProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { buildSquareAuthorizeUrl } from "@/utils/square/square-oauth";
import { isSquareConfigured } from "@/utils/square/square-config";
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
    const { pubkey, signedEvent } = (req.body || {}) as {
      pubkey?: string;
      signedEvent?: unknown;
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
      return res
        .status(verification.status)
        .json({ error: verification.error });
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

    const state = randomBytes(24).toString("hex");
    await createSquareOAuthState(pubkey, state);
    const authorizeUrl = buildSquareAuthorizeUrl(state);

    return res.status(200).json({ success: true, authorizeUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Square OAuth start failed:", message);
    return res.status(500).json({ error: message });
  }
}
