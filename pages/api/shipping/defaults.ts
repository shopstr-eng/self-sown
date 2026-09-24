import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingDefaultsProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  getShippingDefaultsForPubkey,
  upsertShippingDefaults,
} from "@/utils/db/shipping-service";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { consumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";

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
  autoPurchaseLabels?: boolean;
}

function normalizeDefaultsBody(input: unknown): DefaultsBody | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Partial<DefaultsBody>;
  const textFields = [
    "fromName",
    "fromCompany",
    "fromStreet1",
    "fromStreet2",
    "fromCity",
    "fromState",
    "fromZip",
    "fromCountry",
    "fromPhone",
    "fromEmail",
  ] as const;
  if (
    textFields.some((field) => {
      const value = body[field];
      return (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" ||
          value.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(value))
      );
    }) ||
    (body.preferredCarriers !== undefined &&
      (!Array.isArray(body.preferredCarriers) ||
        body.preferredCarriers.some(
          (carrier) => typeof carrier !== "string"
        ))) ||
    (body.autoPurchaseLabels !== undefined &&
      typeof body.autoPurchaseLabels !== "boolean")
  ) {
    return null;
  }

  return {
    ...Object.fromEntries(
      textFields.map((field) => {
        const value = body[field];
        return [field, typeof value === "string" ? value.trim() || null : null];
      })
    ),
    fromCountry: body.fromCountry?.trim().toUpperCase() || "US",
    preferredCarriers: normalizeCarriers(body.preferredCarriers),
    autoPurchaseLabels: body.autoPurchaseLabels !== false,
  } as DefaultsBody;
}

async function saveDefaults(pubkey: string, body: DefaultsBody) {
  return upsertShippingDefaults({
    pubkey,
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
    preferredCarriers: body.preferredCarriers || ["USPS"],
    autoPurchaseLabels: body.autoPurchaseLabels !== false,
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!["GET", "POST"].includes(req.method || "")) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "shipping-defaults", RATE_LIMIT)))
    return;

  if (req.headers.authorization) {
    const auth = await verifyNip98Request(
      req,
      req.method || "GET",
      req.method === "POST" ? req.body : undefined
    );
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    try {
      if (req.method === "GET") {
        const defaults = await getShippingDefaultsForPubkey(auth.pubkey);
        return res.status(200).json({ success: true, defaults });
      }
      if (!(await requireProEntitlement(auth.pubkey, res))) return;
      const body = normalizeDefaultsBody(req.body);
      if (!body) {
        return res.status(400).json({ error: "Invalid shipping defaults" });
      }
      const defaults = await saveDefaults(auth.pubkey, body);
      return res.status(200).json({ success: true, defaults });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Shipping defaults request failed:", message);
      return res
        .status(500)
        .json({ error: "Could not load shipping defaults" });
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
  const rawBody = (req.body || {}) as Partial<DefaultsBody>;
  if (
    !matchesMcpRequestProof(
      event,
      buildShippingDefaultsProof({
        pubkey: event.pubkey,
        method: req.method as "GET" | "POST",
        defaults: req.method === "POST" ? rawBody : undefined,
      })
    )
  ) {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  try {
    if (req.method === "GET") {
      const defaults = await getShippingDefaultsForPubkey(event.pubkey);
      return res.status(200).json({ success: true, defaults });
    }

    // Pro gate: saving shipping defaults is a Herd write. GET stays open so
    // lapsed sellers can still read their saved values.
    if (!(await requireProEntitlement(event.pubkey, res))) return;

    const body = normalizeDefaultsBody(rawBody);
    if (!body) {
      return res.status(400).json({ error: "Invalid shipping defaults" });
    }

    // Single-use: this is a write; burn the proof so it can't be replayed
    // within its freshness window.
    if (!(await consumeSignedRequestProof(event, "shipping_defaults"))) {
      return res
        .status(401)
        .json({ error: "Signed event has already been used." });
    }

    const defaults = await saveDefaults(event.pubkey, body);
    return res.status(200).json({ success: true, defaults });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shipping defaults request failed:", message);
    return res.status(500).json({ error: "Could not load shipping defaults" });
  }
}

function normalizeCarriers(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return ["USPS"];
  const carriers = input
    .map((carrier) =>
      String(carrier || "")
        .trim()
        .toUpperCase()
    )
    .filter((carrier) => KNOWN_CARRIERS.has(carrier));
  return carriers.length > 0 ? Array.from(new Set(carriers)) : ["USPS"];
}
