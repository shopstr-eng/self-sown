// Seller-facing management of the x402 custom Lightning invoice authority
// (Pro feature): a seller running their own LNbits instance can have their
// MCP/x402 Lightning invoices issued by their own node — with the x402
// request hash embedded in the invoice (spec-strict binding) and funds
// landing directly on their infrastructure.
//
// Auth: NIP-98-style signed kind-27235 proof in x-mcp-signed-event, same
// pattern as /api/shipping/defaults. POST is Pro-gated; GET stays readable
// and DELETE stays open so a lapsed seller can always disconnect.

import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import { consumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import {
  deleteSellerX402Authority,
  getSellerX402Authority,
  saveSellerX402Authority,
} from "@/utils/db/x402-service";
import {
  isSafePublicHostname,
  parseHttpUrl,
  safeFetch,
} from "@/utils/url-safety";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const PATH = "/api/x402/authority";

function redact(config: { provider: string; url: string; updatedAt: string }) {
  // Never echo the decrypted API key back — presence + URL is all the UI
  // needs. (apiKeyCiphertext is omitted entirely.)
  return {
    provider: config.provider,
    url: config.url,
    updatedAt: config.updatedAt,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "x402-authority", RATE_LIMIT))) return;

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
  const methodTag = event.tags.find((t) => t[0] === "method")?.[1];
  if (pathTag !== PATH || methodTag !== req.method) {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    if (req.method === "GET") {
      const config = await getSellerX402Authority(event.pubkey);
      return res.status(200).json({
        success: true,
        authority: config ? redact(config) : null,
      });
    }

    if (req.method === "DELETE") {
      // Deliberately NOT Pro-gated: a lapsed seller must always be able to
      // disconnect their own infrastructure.
      if (!(await consumeSignedRequestProof(event, "x402_authority"))) {
        return res
          .status(401)
          .json({ error: "Signed event has already been used." });
      }
      await deleteSellerX402Authority(event.pubkey);
      return res.status(200).json({ success: true, authority: null });
    }

    // POST — Herd (Pro) feature.
    if (!(await requireProEntitlement(event.pubkey, res))) return;
    if (!(await consumeSignedRequestProof(event, "x402_authority"))) {
      return res
        .status(401)
        .json({ error: "Signed event has already been used." });
    }

    const body = (req.body || {}) as {
      provider?: string;
      url?: string;
      apiKey?: string;
    };
    if (body.provider !== "lnbits") {
      return res.status(400).json({
        error: "Only the 'lnbits' invoice authority provider is supported.",
      });
    }
    const urlValue = (body.url || "").trim();
    const apiKey = (body.apiKey || "").trim();
    const parsed = parseHttpUrl(urlValue);
    if (!parsed || parsed.protocol !== "https:") {
      return res.status(400).json({
        error:
          "The authority URL must be a valid https:// URL pointing at your LNbits instance.",
      });
    }
    if (!(await isSafePublicHostname(parsed.hostname))) {
      return res.status(400).json({
        error: "The authority URL must resolve to a public host.",
      });
    }
    if (!apiKey || apiKey.length > 512) {
      return res
        .status(400)
        .json({ error: "An LNbits API key (inkey/adminkey) is required." });
    }

    // Verify the key actually works before saving: a typo'd key would
    // otherwise silently break every Lightning checkout for this seller.
    const base = urlValue.replace(/\/+$/, "");
    let walletRes: Response;
    try {
      walletRes = await safeFetch(`${base}/api/v1/wallet`, {
        accept: "application/json",
        timeoutMs: 10000,
        headers: { "X-Api-Key": apiKey },
      });
    } catch (error) {
      return res.status(400).json({
        error: `Could not reach the LNbits instance: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
    }
    if (!walletRes.ok) {
      return res.status(400).json({
        error: `The LNbits instance rejected the API key (HTTP ${walletRes.status}). Check the key and try again.`,
      });
    }

    await saveSellerX402Authority(event.pubkey, {
      provider: "lnbits",
      url: base,
      apiKey,
    });
    const saved = await getSellerX402Authority(event.pubkey);
    return res.status(200).json({
      success: true,
      authority: saved ? redact(saved) : null,
    });
  } catch (error) {
    console.error("x402 authority route failed:", error);
    return res.status(500).json({
      error: "Failed to process the invoice authority request",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
