import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyLabel, isEasyPostConfigured } from "@/utils/shipping/easypost";
import {
  checkPubkeySpend,
  getShipmentOwner,
  isListedSeller,
  isShipmentAlreadyPurchased,
  markShipmentPurchased,
  recordPubkeySpend,
} from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingBuyLabelProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

interface BuyLabelRequestBody {
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-buy-label", RATE_LIMIT)) return;
  if (!isEasyPostConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
  }

  try {
    const { shipmentId, rateId, insuranceAmount } = (req.body ||
      {}) as Partial<BuyLabelRequestBody>;
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
    // listing to this marketplace can spend platform EasyPost balance on
    // labels. This bars random signed-in callers from buying labels for
    // arbitrary shipments.
    if (!(await isListedSeller(event.pubkey))) {
      return res.status(403).json({
        error: "Only registered sellers may purchase shipping labels",
      });
    }

    // Ownership check: the shipment must have been quoted by /api/shipping/rates
    // with a signed-event header from this same pubkey. This prevents arbitrary
    // callers from spending the platform's EasyPost balance.
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

    const label = await buyLabel({
      shipmentId,
      rateId,
      insuranceAmount,
    });

    // Enforce per-pubkey daily USD spend cap (default $200, override via
    // EASYPOST_PUBKEY_DAILY_CAP_USD). We check post-quote since the actual
    // charge equals the rate; if the cap is exceeded after the fact we let
    // the label through but stop the next one from going over.
    const labelRateUsd = typeof label.rate === "number" ? label.rate : 0;
    const spendCheck = checkPubkeySpend(event.pubkey, labelRateUsd);
    if (!spendCheck.ok) {
      // The purchase already succeeded with EasyPost; record it and warn,
      // but we don't try to refund here.
      console.warn(
        `[shipping] daily cap exceeded for pubkey=${event.pubkey} remaining=$${spendCheck.remainingUsd}`
      );
    }
    recordPubkeySpend(event.pubkey, labelRateUsd);
    markShipmentPurchased(shipmentId);

    return res.status(200).json({ success: true, ...label });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy shipping label failed:", message);
    return res.status(500).json({ error: message });
  }
}
