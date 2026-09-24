import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
  type McpRequestProof,
} from "@/utils/mcp/request-proof";
import { listShippingLabelsForPubkey } from "@/utils/db/shipping-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function buildListProof(pubkey: string): McpRequestProof {
  return {
    action: "shipping_list_labels",
    method: "GET",
    path: "/api/shipping/labels",
    pubkey,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "shipping-labels-list", RATE_LIMIT)))
    return;

  if (req.headers.authorization) {
    const auth = await verifyNip98Request(req, "GET");
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const rawOrderId = Array.isArray(req.query.orderId)
      ? req.query.orderId[0]
      : req.query.orderId;
    if (rawOrderId !== undefined && !ORDER_ID.test(rawOrderId)) {
      return res.status(400).json({ error: "Invalid orderId" });
    }
    try {
      const labels = await listShippingLabelsForPubkey(
        auth.pubkey,
        200,
        rawOrderId
      );
      return res.status(200).json({ success: true, labels });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("List shipping labels failed:", message);
      return res.status(500).json({ error: "Could not load shipping labels" });
    }
  }

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

  const expected = buildListProof(event.pubkey);
  if (!matchesMcpRequestProof(event, expected)) {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    const labels = await listShippingLabelsForPubkey(event.pubkey, 200);
    return res.status(200).json({ success: true, labels });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("List shipping labels failed:", message);
    return res.status(500).json({ error: "Could not load shipping labels" });
  }
}
