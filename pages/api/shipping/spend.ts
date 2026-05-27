import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import { getDailySpendForPubkey } from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-spend", RATE_LIMIT)) return;

  const signedHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
  const signedHeaderValue = Array.isArray(signedHeader)
    ? signedHeader[0]
    : signedHeader;
  if (!signedHeaderValue) {
    return res.status(401).json({ error: "Missing signed event" });
  }
  const event = parseSignedEventHeader(signedHeaderValue);
  if (!event || event.kind !== MCP_REQUEST_PROOF_KIND || !verifyEvent(event)) {
    return res.status(401).json({ error: "Invalid signed event" });
  }
  if (!isMcpRequestProofFresh(event)) {
    return res.status(401).json({ error: "Signed event expired" });
  }
  const pathTag = event.tags.find((t) => t[0] === "path")?.[1];
  if (pathTag !== "/api/shipping/spend") {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    const spend = await getDailySpendForPubkey(event.pubkey);
    return res.status(200).json({ success: true, spend });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Get shipping spend failed:", message);
    return res.status(500).json({ error: message });
  }
}
