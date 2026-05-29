import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyLabel } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import {
  claimShipmentForPurchase,
  getShipmentOwner,
  isListedSeller,
  releaseShipmentClaim,
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
  getShippoAccessToken,
  insertShippingLabel,
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
  if (!isShippoOAuthConfigured()) {
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
    // listing to this marketplace may purchase labels. This bars random
    // signed-in callers from buying labels for arbitrary shipments.
    if (!(await isListedSeller(event.pubkey))) {
      return res.status(403).json({
        error: "Only registered sellers may purchase shipping labels",
      });
    }

    // Ownership check: the shipment must have been quoted by /api/shipping/rates
    // with a signed-event header from this same pubkey. This prevents callers
    // from buying labels against a shipment they did not quote.
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

    // Atomically claim this shipment BEFORE any `await`, so two concurrent
    // requests can never both buy the same label (a duplicate charge). The
    // claim is released below if the purchase cannot be completed, so the
    // seller can retry.
    if (!claimShipmentForPurchase(shipmentId)) {
      return res
        .status(409)
        .json({ error: "Shipment label already purchased" });
    }

    try {
      // Resolve the seller's own connected Shippo account. Shippo bills the
      // seller directly, so there is no platform spend cap to enforce.
      const accessToken = await getShippoAccessToken(event.pubkey);
      if (!accessToken) {
        releaseShipmentClaim(shipmentId);
        return res.status(409).json({
          error:
            "Connect your Shippo account in Settings → Shipping before buying labels.",
        });
      }

      const label = await buyLabel(accessToken, {
        shipmentId,
        rateId,
        insuranceAmount,
      });

      // Purchase succeeded — keep the claim as the permanent "purchased" marker.
      let dbId: number | null = null;
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
        // Label history insert failed AFTER Shippo charged the seller. Log
        // loudly so operators can reconcile — the seller still gets the label.
        console.error(
          "CRITICAL: Shippo label purchased but history insert failed",
          { pubkey: event.pubkey, shipmentId: label.shipmentId, dbErr }
        );
      }

      return res.status(200).json({ success: true, id: dbId, ...label });
    } catch (buyErr) {
      // Purchase failed before/at Shippo — release the claim so the seller can
      // retry this shipment.
      releaseShipmentClaim(shipmentId);
      throw buyErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy shipping label failed:", message);
    return res.status(500).json({ error: message });
  }
}
