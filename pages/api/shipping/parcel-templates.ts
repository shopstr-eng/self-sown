import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  deleteParcelTemplate,
  listParcelTemplatesForPubkey,
  upsertParcelTemplate,
} from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

interface TemplateBody {
  name: string;
  weightOz: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  id?: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-parcel-templates", RATE_LIMIT))
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
  const pathTag = event.tags.find((t) => t[0] === "path")?.[1];
  const methodTag = event.tags.find((t) => t[0] === "method")?.[1];
  if (
    pathTag !== "/api/shipping/parcel-templates" ||
    methodTag !== req.method
  ) {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    if (req.method === "GET") {
      const templates = await listParcelTemplatesForPubkey(event.pubkey);
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === "POST") {
      const body = (req.body || {}) as Partial<TemplateBody>;
      if (!body.name || !body.weightOz || body.weightOz <= 0) {
        return res
          .status(400)
          .json({ error: "name and weightOz (> 0) are required" });
      }
      const template = await upsertParcelTemplate({
        pubkey: event.pubkey,
        name: String(body.name).trim().slice(0, 80),
        weightOz: Number(body.weightOz),
        lengthIn: body.lengthIn ? Number(body.lengthIn) : null,
        widthIn: body.widthIn ? Number(body.widthIn) : null,
        heightIn: body.heightIn ? Number(body.heightIn) : null,
      });
      return res.status(200).json({ success: true, template });
    }

    if (req.method === "DELETE") {
      const idRaw =
        req.query.id || (req.body && (req.body as { id?: unknown }).id);
      const id = Number(idRaw);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Valid id is required" });
      }
      const ok = await deleteParcelTemplate(event.pubkey, id);
      return res.status(200).json({ success: ok });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Parcel templates request failed:", message);
    return res.status(500).json({ error: message });
  }
}
