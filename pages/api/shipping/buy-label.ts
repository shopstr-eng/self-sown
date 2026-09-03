import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { purchaseOutboundLabel } from "@/utils/shipping/outbound-label-purchase";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { getSellerOrderState } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingBuyLabelProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  getShipmentClaim,
  getShippoAccessToken,
} from "@/utils/db/shipping-service";
import { consumeSignedRequestProof } from "@/utils/mcp/request-proof-server";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_INSURANCE_AMOUNT = 1_000_000;
const MAX_SUMMARY_LENGTH = 1_024;

interface BuyLabelRequestBody {
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
  orderId: string;
  fromSummary?: string;
  toSummary?: string;
  parcelSummary?: string;
}

function isValidSummary(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length <= MAX_SUMMARY_LENGTH &&
      !CONTROL_CHARACTERS.test(value))
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "shipping-buy-label", RATE_LIMIT))) {
    return;
  }
  if (!isShippoOAuthConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
  }

  try {
    const body = (req.body || {}) as Partial<BuyLabelRequestBody>;
    const {
      shipmentId,
      rateId,
      insuranceAmount,
      orderId,
      fromSummary,
      toSummary,
      parcelSummary,
    } = body;
    if (
      typeof shipmentId !== "string" ||
      !PROVIDER_ID.test(shipmentId) ||
      typeof rateId !== "string" ||
      !PROVIDER_ID.test(rateId) ||
      typeof orderId !== "string" ||
      !ORDER_ID.test(orderId) ||
      !isValidSummary(fromSummary) ||
      !isValidSummary(toSummary) ||
      !isValidSummary(parcelSummary) ||
      (insuranceAmount !== undefined &&
        (typeof insuranceAmount !== "number" ||
          !Number.isFinite(insuranceAmount) ||
          insuranceAmount < 0 ||
          insuranceAmount > MAX_INSURANCE_AMOUNT))
    ) {
      return res.status(400).json({ error: "Invalid label purchase request" });
    }

    let pubkey: string;
    let signedEvent: ReturnType<typeof parseSignedEventHeader> = null;

    if (req.headers.authorization) {
      const auth = await verifyNip98Request(req, "POST", req.body);
      if (!auth.ok) return res.status(401).json({ error: auth.error });
      pubkey = auth.pubkey;
    } else {
      const rawHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
      const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (!header) {
        return res
          .status(401)
          .json({ error: "Missing signed event for label purchase" });
      }

      signedEvent = parseSignedEventHeader(header);
      if (
        !signedEvent ||
        signedEvent.kind !== MCP_REQUEST_PROOF_KIND ||
        !verifyEvent(signedEvent)
      ) {
        return res.status(401).json({ error: "Invalid signed event" });
      }
      if (!isMcpRequestProofFresh(signedEvent)) {
        return res.status(401).json({ error: "Signed event expired" });
      }
      if (
        !matchesMcpRequestProof(
          signedEvent,
          buildShippingBuyLabelProof({
            pubkey: signedEvent.pubkey,
            orderId,
            shipmentId,
            rateId,
          })
        )
      ) {
        return res
          .status(401)
          .json({ error: "Signed event does not match request" });
      }
      pubkey = signedEvent.pubkey;
    }

    if (!(await isListedSeller(pubkey))) {
      return res.status(403).json({
        error: "Only registered sellers may purchase shipping labels",
      });
    }
    if (!(await requireProEntitlement(pubkey, res))) return;

    const order = await getSellerOrderState(orderId, pubkey);
    if (!order) {
      return res
        .status(403)
        .json({ error: "Order does not belong to this seller" });
    }
    if (order.status !== "confirmed") {
      return res.status(409).json({
        error: "Only confirmed orders can purchase an outbound label",
      });
    }

    const shipment = await getShipmentClaim(shipmentId);
    if (!shipment) {
      return res.status(403).json({
        error:
          "Shipment not registered for purchase. Re-quote rates while signed in.",
      });
    }
    if (shipment.pubkey !== pubkey || shipment.orderId !== orderId) {
      return res.status(403).json({
        error: "Shipment is not bound to this seller and order",
      });
    }

    const accessToken = await getShippoAccessToken(pubkey);
    if (!accessToken) {
      return res.status(409).json({
        error:
          "Connect your Shippo account in Settings → Shipping before buying labels.",
      });
    }

    if (
      signedEvent &&
      !(await consumeSignedRequestProof(signedEvent, "shipping_buy_label"))
    ) {
      return res
        .status(401)
        .json({ error: "Signed event has already been used." });
    }

    const purchase = await purchaseOutboundLabel({
      sellerPubkey: pubkey,
      orderId,
      accessToken,
      shipmentId,
      rateId,
      insuranceAmount,
      claimShipment: true,
      fromSummary: fromSummary ?? null,
      toSummary: toSummary ?? null,
      parcelSummary: parcelSummary ?? null,
    });

    if (purchase.status === "order-already-claimed") {
      return res.status(409).json({ error: "Order label already purchased" });
    }
    if (purchase.status === "shipment-already-claimed") {
      return res
        .status(409)
        .json({ error: "Shipment label already purchased" });
    }
    if (purchase.status === "uncertain") {
      return res.status(502).json({
        error:
          "Shippo did not confirm the purchase. Check Shippo before attempting another label.",
      });
    }

    return res
      .status(200)
      .json({ success: true, id: purchase.labelId, ...purchase.label });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Buy shipping label failed:", message);
    return res.status(500).json({ error: "Could not purchase shipping label" });
  }
}
