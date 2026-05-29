import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes } from "crypto";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildShippingOAuthStartProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import {
  buildShippoAuthorizeUrl,
  isShippoOAuthConfigured,
} from "@/utils/shipping/shippo-oauth";
import { createShippoOAuthState } from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-oauth-start", RATE_LIMIT)) return;
  if (!isShippoOAuthConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
  }

  try {
    const { pubkey, signedEvent } = (req.body || {}) as {
      pubkey?: string;
      signedEvent?: unknown;
    };
    if (!pubkey) {
      return res.status(400).json({ error: "pubkey is required" });
    }

    // Accept the signed event from the body or the standard header.
    const headerValue = req.headers[MCP_SIGNED_EVENT_HEADER];
    const normalizedHeader = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    const event =
      (signedEvent as Parameters<
        typeof verifyAndConsumeSignedRequestProof
      >[0]) ||
      (typeof normalizedHeader === "string"
        ? parseSignedEventHeader(normalizedHeader) ?? undefined
        : undefined);

    const verification = await verifyAndConsumeSignedRequestProof(
      event,
      buildShippingOAuthStartProof(pubkey)
    );
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    const state = randomBytes(24).toString("hex");
    await createShippoOAuthState(pubkey, state);
    const authorizeUrl = buildShippoAuthorizeUrl(state);

    return res.status(200).json({ success: true, authorizeUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shippo OAuth start failed:", message);
    return res.status(500).json({ error: message });
  }
}
