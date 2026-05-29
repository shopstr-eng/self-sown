import { createHash } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyReturnLabel } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  claimShipmentForPurchase,
  getShippoAccessToken,
  getShippingDefaultsForPubkey,
  insertShippingLabel,
  releaseShipmentClaim,
} from "@/utils/db/shipping-service";
import type { ParcelInput, ShippingAddressInput } from "@/utils/shipping/types";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

interface ReturnLabelBody {
  // Return origin — typically the buyer's delivery address from the order.
  // The destination is ALWAYS the seller's saved ship-from defaults; clients
  // cannot redirect the return shipment anywhere else.
  from: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[];
  serviceToken?: string;
  insuranceAmount?: number;
  orderId?: string;
}

function fmtAddr(a: ShippingAddressInput): string {
  return [a.name, a.street1, a.city, a.state, a.zip].filter(Boolean).join(", ");
}

function fmtParcel(p: ParcelInput): string {
  const dims =
    p.lengthIn && p.widthIn && p.heightIn
      ? ` ${p.lengthIn}×${p.widthIn}×${p.heightIn} in`
      : "";
  return `${p.weightOz} oz${dims}`;
}

// Produce a stable, canonical representation so logically-identical return
// requests hash to the same idempotency key regardless of object key order,
// string casing/whitespace, or array ordering produced by different clients.
function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) {
    // Sort so order-insensitive lists (e.g. carriers) hash identically.
    return value
      .map(canonicalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      if (obj[k] === undefined) continue;
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value ?? null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-return-label", RATE_LIMIT)) return;
  if (!isShippoOAuthConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
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
  const pathTag = event.tags.find((t) => t[0] === "path")?.[1];
  if (pathTag !== "/api/shipping/return-label") {
    return res
      .status(401)
      .json({ error: "Signed event does not match request" });
  }

  if (!(await isListedSeller(event.pubkey))) {
    return res
      .status(403)
      .json({ error: "Only registered sellers may purchase return labels" });
  }

  // Authorization: the return label's destination is locked to the seller's
  // saved ship-from defaults. This prevents an authenticated seller from
  // funneling platform-paid labels to arbitrary addresses by passing a
  // forged `to` in the body.
  const defaults = await getShippingDefaultsForPubkey(event.pubkey);
  if (
    !defaults ||
    !defaults.fromStreet1 ||
    !defaults.fromCity ||
    !defaults.fromState ||
    !defaults.fromZip
  ) {
    return res.status(400).json({
      error:
        "Set a default ship-from address in Settings → Shipping before issuing return labels.",
    });
  }
  const lockedTo: ShippingAddressInput = {
    name: defaults.fromName || undefined,
    company: defaults.fromCompany || undefined,
    street1: defaults.fromStreet1,
    street2: defaults.fromStreet2 || undefined,
    city: defaults.fromCity,
    state: defaults.fromState,
    zip: defaults.fromZip,
    country: defaults.fromCountry || "US",
    phone: defaults.fromPhone || undefined,
    email: defaults.fromEmail || undefined,
  };

  try {
    const body = (req.body || {}) as Partial<ReturnLabelBody>;
    if (
      !body.from?.street1 ||
      !body.from?.city ||
      !body.from?.state ||
      !body.from?.zip
    ) {
      return res
        .status(400)
        .json({ error: "Complete return-from address is required" });
    }
    if (!body.parcel?.weightOz || body.parcel.weightOz <= 0) {
      return res
        .status(400)
        .json({ error: "parcel.weightOz (oz) is required and must be > 0" });
    }

    // Resolve the seller's own connected Shippo account. Shippo bills the
    // seller directly, so there is no platform spend cap to enforce.
    const accessToken = await getShippoAccessToken(event.pubkey);
    if (!accessToken) {
      return res.status(409).json({
        error:
          "Connect your Shippo account in Settings → Shipping before issuing return labels.",
      });
    }

    // Return labels create a brand-new Shippo shipment each call, so there is
    // no client shipmentId to dedupe on. Derive a deterministic idempotency key
    // from the seller + the fields that define this return, and claim it in the
    // shared registry so a double-click/retry can't buy two identical returns.
    const idempotencyKey =
      "return:" +
      createHash("sha256")
        .update(
          JSON.stringify(
            canonicalize({
              pubkey: event.pubkey,
              orderId: body.orderId ?? null,
              from: body.from,
              to: lockedTo,
              parcel: body.parcel,
              carriers: body.carriers ?? null,
              serviceToken: body.serviceToken ?? null,
              insuranceAmount: body.insuranceAmount ?? null,
            })
          )
        )
        .digest("hex");

    if (!(await claimShipmentForPurchase(idempotencyKey, event.pubkey))) {
      return res.status(409).json({
        error:
          "A return label for this order was already issued. Refresh to see it.",
      });
    }

    try {
      const label = await buyReturnLabel(accessToken, {
        from: body.from as ShippingAddressInput,
        to: lockedTo,
        parcel: body.parcel as ParcelInput,
        carriers: body.carriers,
        serviceToken: body.serviceToken,
        insuranceAmount: body.insuranceAmount,
      });

      let dbId: number | null = null;
      try {
        const rec = await insertShippingLabel({
          pubkey: event.pubkey,
          shipmentId: label.shipmentId,
          orderId: body.orderId ?? null,
          trackingCode: label.trackingCode || null,
          trackingUrl: label.trackingUrl ?? null,
          labelUrl: label.labelUrl,
          labelFormat: label.labelFormat,
          rateUsd: label.rate,
          currency: label.currency,
          carrier: label.carrier,
          service: label.service,
          isReturn: true,
          fromSummary: fmtAddr(body.from as ShippingAddressInput),
          toSummary: fmtAddr(lockedTo),
          parcelSummary: fmtParcel(body.parcel as ParcelInput),
        });
        dbId = rec.id;
      } catch (dbErr) {
        console.error(
          "CRITICAL: Shippo return label purchased but history insert failed",
          { pubkey: event.pubkey, shipmentId: label.shipmentId, dbErr }
        );
      }

      return res.status(200).json({ success: true, id: dbId, ...label });
    } catch (buyErr) {
      // Purchase failed before/at Shippo — release the claim so the seller can
      // retry this return.
      await releaseShipmentClaim(idempotencyKey);
      throw buyErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy return label failed:", message);
    return res.status(500).json({ error: message });
  }
}
