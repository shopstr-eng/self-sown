import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyLabel, isShippoConfigured } from "@/utils/shipping/shippo";
import {
  getShipmentOwner,
  isListedSeller,
  isShipmentAlreadyPurchased,
  markShipmentPurchased,
} from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingBuyLabelProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  getDailySpendForPubkey,
  insertShippingLabel,
  withPubkeySpendLock,
} from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

interface BuyLabelRequestBody {
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
  orderId?: string;
  fromSummary?: string;
  toSummary?: string;
  parcelSummary?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-buy-label", RATE_LIMIT)) return;
  if (!isShippoConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
  }

  try {
    const {
      shipmentId,
      rateId,
      insuranceAmount,
      orderId,
      fromSummary,
      toSummary,
      parcelSummary,
    } = (req.body || {}) as Partial<BuyLabelRequestBody>;
    if (!shipmentId || !rateId) {
      return res
        .status(400)
        .json({ error: "shipmentId and rateId are required" });
    }

    const signedHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
    const signedHeaderValue = Array.isArray(signedHeader)
      ? signedHeader[0]
      : signedHeader;
    if (!signedHeaderValue) {
      return res
        .status(401)
        .json({ error: "Missing signed event for label purchase" });
    }

    const event = parseSignedEventHeader(signedHeaderValue);
    if (
      !event ||
      event.kind !== MCP_REQUEST_PROOF_KIND ||
      !verifyEvent(event)
    ) {
      return res.status(401).json({ error: "Invalid signed event" });
    }
    if (!isMcpRequestProofFresh(event)) {
      return res.status(401).json({ error: "Signed event expired" });
    }

    const proof = buildShippingBuyLabelProof({
      pubkey: event.pubkey,
      shipmentId,
      rateId,
    });
    if (!matchesMcpRequestProof(event, proof)) {
      return res
        .status(401)
        .json({ error: "Signed event does not match request" });
    }

    // Entitlement check: only pubkeys that have published at least one product
    // listing to this marketplace can spend platform Shippo balance on
    // labels. This bars random signed-in callers from buying labels for
    // arbitrary shipments.
    if (!(await isListedSeller(event.pubkey))) {
      return res.status(403).json({
        error: "Only registered sellers may purchase shipping labels",
      });
    }

    // Ownership check: the shipment must have been quoted by /api/shipping/rates
    // with a signed-event header from this same pubkey. This prevents arbitrary
    // callers from spending the platform's Shippo balance.
    const owner = getShipmentOwner(shipmentId);
    if (!owner) {
      return res.status(403).json({
        error:
          "Shipment not registered for purchase. Re-quote rates while signed in.",
      });
    }
    if (owner !== event.pubkey) {
      return res
        .status(403)
        .json({ error: "Shipment is owned by a different pubkey" });
    }

    // Single-use lock: never buy the same shipment label twice.
    if (isShipmentAlreadyPurchased(shipmentId)) {
      return res
        .status(409)
        .json({ error: "Shipment label already purchased" });
    }

    // Serialize concurrent purchases for this pubkey via a Postgres
    // advisory lock, then enforce the daily USD spend cap (default $200,
    // override via SHIPPO_PUBKEY_DAILY_CAP_USD). Charging Shippo and
    // appending the spend ledger row happen inside the lock so the cap
    // can be at most exceeded by one in-flight label, not by N racers.
    type SpendStatus = Awaited<ReturnType<typeof getDailySpendForPubkey>>;
    let dbId: number | null = null;
    let labelResult: Awaited<ReturnType<typeof buyLabel>> | null = null;
    let capError: { spend: SpendStatus; message: string } | null = null;
    let spend: SpendStatus | null = null;
    let postSpend: SpendStatus | null = null;

    await withPubkeySpendLock(event.pubkey, async (status) => {
      spend = status;
      if (status.remainingUsd <= 0) {
        capError = {
          spend: status,
          message: `Daily shipping spend cap reached ($${status.capUsd.toFixed(2)}). Try again later.`,
        };
        return;
      }

      const label = await buyLabel({ shipmentId, rateId, insuranceAmount });
      labelResult = label;
      markShipmentPurchased(shipmentId);

      try {
        const rec = await insertShippingLabel({
          pubkey: event.pubkey,
          shipmentId: label.shipmentId,
          orderId: orderId ?? null,
          trackingCode: label.trackingCode || null,
          trackingUrl: label.trackingUrl ?? null,
          labelUrl: label.labelUrl,
          labelFormat: label.labelFormat,
          rateUsd: label.rate,
          currency: label.currency,
          carrier: label.carrier,
          service: label.service,
          isReturn: false,
          fromSummary: fromSummary ?? null,
          toSummary: toSummary ?? null,
          parcelSummary: parcelSummary ?? null,
        });
        dbId = rec.id;
      } catch (dbErr) {
        // Spend ledger insert failed AFTER Shippo charged. Log loudly so
        // operators can reconcile manually — the seller still gets the
        // label below, but the daily cap will under-count until corrected.
        console.error(
          "CRITICAL: Shippo label purchased but ledger insert failed",
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
    const lr = labelResult as Awaited<ReturnType<typeof buyLabel>> | null;
    if (!lr) {
      return res.status(500).json({ error: "Label purchase failed" });
    }

    return res.status(200).json({
      success: true,
      id: dbId,
      ...lr,
      spend: (postSpend as SpendStatus | null) ?? (spend as SpendStatus | null),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy shipping label failed:", message);
    return res.status(500).json({ error: message });
  }
}
