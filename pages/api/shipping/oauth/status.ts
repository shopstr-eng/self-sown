import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildShippingOAuthStatusProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { getShippoConnection } from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-oauth-status", RATE_LIMIT)) return;

  try {
    const pubkey = (req.query.pubkey as string) || "";
    if (!pubkey) {
      return res.status(400).json({ error: "pubkey is required" });
    }

    const headerValue = req.headers[MCP_SIGNED_EVENT_HEADER];
    const normalizedHeader = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    const event =
      typeof normalizedHeader === "string"
        ? parseSignedEventHeader(normalizedHeader) ?? undefined
        : undefined;

    const verification = await verifyAndConsumeSignedRequestProof(
      event,
      buildShippingOAuthStatusProof(pubkey)
    );
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    if (!isShippoOAuthConfigured()) {
      return res.status(200).json({ configured: false, connected: false });
    }

    const conn = await getShippoConnection(pubkey);
    return res.status(200).json({
      configured: true,
      connected: !!conn,
      accountId: conn?.accountId ?? null,
      scope: conn?.scope ?? null,
      connectedAt: conn?.createdAt ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shippo OAuth status failed:", message);
    return res.status(500).json({ error: message });
  }
}
