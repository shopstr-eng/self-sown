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
  getShippingDefaultsForPubkey,
  upsertShippingDefaults,
} from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

const KNOWN_CARRIERS = new Set([
  "USPS",
  "UPS",
  "FEDEX",
  "DHL_EXPRESS",
  "CANADA_POST",
]);

interface DefaultsBody {
  fromName?: string | null;
  fromCompany?: string | null;
  fromStreet1?: string | null;
  fromStreet2?: string | null;
  fromCity?: string | null;
  fromState?: string | null;
  fromZip?: string | null;
  fromCountry?: string | null;
  fromPhone?: string | null;
  fromEmail?: string | null;
  preferredCarriers?: string[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!["GET", "POST"].includes(req.method || "")) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-defaults", RATE_LIMIT)) return;

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
  if (pathTag !== "/api/shipping/defaults" || methodTag !== req.method) {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    if (req.method === "GET") {
      const defaults = await getShippingDefaultsForPubkey(event.pubkey);
      return res.status(200).json({ success: true, defaults });
    }

    const body = (req.body || {}) as Partial<DefaultsBody>;
    const carriers = (body.preferredCarriers || [])
      .map((c) =>
        String(c || "")
          .trim()
          .toUpperCase()
      )
      .filter((c) => KNOWN_CARRIERS.has(c));
    const defaults = await upsertShippingDefaults({
      pubkey: event.pubkey,
      fromName: body.fromName ?? null,
      fromCompany: body.fromCompany ?? null,
      fromStreet1: body.fromStreet1 ?? null,
      fromStreet2: body.fromStreet2 ?? null,
      fromCity: body.fromCity ?? null,
      fromState: body.fromState ?? null,
      fromZip: body.fromZip ?? null,
      fromCountry: body.fromCountry || "US",
      fromPhone: body.fromPhone ?? null,
      fromEmail: body.fromEmail ?? null,
      preferredCarriers: carriers.length > 0 ? carriers : ["USPS"],
    });
    return res.status(200).json({ success: true, defaults });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shipping defaults request failed:", message);
    return res.status(500).json({ error: message });
  }
}
