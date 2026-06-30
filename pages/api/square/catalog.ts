import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildSquareCatalogImportProof,
  parseSignedEventHeader,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { isSquareConfigured } from "@/utils/square/square-config";
import {
  getValidSquareAccessToken,
  fetchSquareCatalog,
} from "@/utils/square/square-api";

// Seller-facing Square catalog read used by the import modal. Authenticated with
// a NIP-98-style signed kind-27235 proof bound to the seller's pubkey (mirrors
// the oauth/status endpoint). Fails closed when Square is unconfigured or the
// seller has no connected account.
const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "square-catalog-import", RATE_LIMIT)))
    return;

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
        ? (parseSignedEventHeader(normalizedHeader) ?? undefined)
        : undefined;

    const verification = await verifyAndConsumeSignedRequestProof(
      event,
      buildSquareCatalogImportProof(pubkey)
    );
    if (!verification.ok) {
      return res
        .status(verification.status)
        .json({ error: verification.error });
    }

    if (!isSquareConfigured()) {
      return res.status(503).json({ error: "Square is not available" });
    }

    const access = await getValidSquareAccessToken(pubkey);
    if (!access) {
      return res.status(409).json({
        error:
          "No Square account connected. Connect Square under payment settings first.",
      });
    }

    const items = await fetchSquareCatalog(access.accessToken);
    return res.status(200).json({ configured: true, items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Square catalog import failed:", message);
    return res.status(500).json({ error: message });
  }
}
