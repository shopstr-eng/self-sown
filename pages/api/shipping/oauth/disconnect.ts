import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildShippingOAuthDisconnectProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { deleteShippoConnection } from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-oauth-disconnect", RATE_LIMIT))
    return;

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
      buildShippingOAuthDisconnectProof(pubkey)
    );
    if (!verification.ok) {
      return res
        .status(verification.status)
        .json({ error: verification.error });
    }

    await deleteShippoConnection(pubkey);
    return res.status(200).json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shippo OAuth disconnect failed:", message);
    return res.status(500).json({ error: message });
  }
}
