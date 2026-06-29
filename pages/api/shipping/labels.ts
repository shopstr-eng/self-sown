import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
  type McpRequestProof,
} from "@/utils/mcp/request-proof";
import { listShippingLabelsForPubkey } from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

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

  // Verify the action tag matches a list request from this pubkey. We don't
  // call matchesMcpRequestProof here because the only required fields are
  // action/method/path/pubkey, which we re-derive.
  const expected = buildListProof(event.pubkey);
  const actionTag = event.tags.find((t) => t[0] === "action")?.[1];
  const pathTag = event.tags.find((t) => t[0] === "path")?.[1];
  if (actionTag !== expected.action || pathTag !== expected.path) {
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
    return res.status(500).json({ error: message });
  }
}
