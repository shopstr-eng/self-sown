import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyReturnLabel, isShippoConfigured } from "@/utils/shipping/shippo";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  getDailySpendForPubkey,
  getShippingDefaultsForPubkey,
  insertShippingLabel,
  withPubkeySpendLock,
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-return-label", RATE_LIMIT)) return;
  if (!isShippoConfigured()) {
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

    type SpendStatus = Awaited<ReturnType<typeof getDailySpendForPubkey>>;
    let dbId: number | null = null;
    let labelResult: Awaited<ReturnType<typeof buyReturnLabel>> | null = null;
    let capError: { spend: SpendStatus; message: string } | null = null;
    let spend: SpendStatus | null = null;
    let postSpend: SpendStatus | null = null;

    await withPubkeySpendLock(event.pubkey, async (status) => {
      spend = status;
      if (status.remainingUsd <= 0) {
        capError = {
          spend: status,
          message: `Daily shipping spend cap reached ($${status.capUsd.toFixed(2)}).`,
        };
        return;
      }

      const label = await buyReturnLabel({
        from: body.from as ShippingAddressInput,
        to: lockedTo,
        parcel: body.parcel as ParcelInput,
        carriers: body.carriers,
        serviceToken: body.serviceToken,
        insuranceAmount: body.insuranceAmount,
      });
      labelResult = label;

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
          "CRITICAL: Shippo return label purchased but ledger insert failed",
          { pubkey: event.pubkey, shipmentId: label.shipmentId, dbErr }
        );
      }

      postSpend = await getDailySpendForPubkey(event.pubkey).catch(
        () => status
      );
    });

    const ce = capError as { spend: SpendStatus; message: string } | null;
    if (ce) {
      return res.status(429).json({ error: ce.message, spend: ce.spend });
    }
    const lr = labelResult as Awaited<ReturnType<typeof buyReturnLabel>> | null;
    if (!lr) {
      return res.status(500).json({ error: "Return label purchase failed" });
    }

    return res.status(200).json({
      success: true,
      id: dbId,
      ...lr,
      spend: (postSpend as SpendStatus | null) ?? (spend as SpendStatus | null),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy return label failed:", message);
    return res.status(500).json({ error: message });
  }
}
