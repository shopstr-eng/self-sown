import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { buyLabel } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingBuyLabelProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import {
  claimAutoLabelPurchase,
  claimShipmentForPurchase,
  getShipmentOwner,
  getShippoAccessToken,
  insertShippingLabel,
  markAutoLabelPurchased,
  releaseAutoLabelClaim,
  releaseShipmentClaim,
} from "@/utils/db/shipping-service";
import {
  buildLabelReconcileToken,
  resolveOrderLabelClaimConflict,
} from "@/utils/shipping/claim-reconcile";
import { consumeSignedRequestProof } from "@/utils/mcp/request-proof-server";

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
  if (!(await applyRateLimit(req, res, "shipping-buy-label", RATE_LIMIT)))
    return;
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
    // The order-level purchase claim (shared with the auto-purchase paths)
    // only guards against double-charging when an orderId is supplied, so
    // require it — an orderless manual buy could charge alongside an
    // auto-purchase for the same order.
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
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
      orderId,
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

    // Pro gate: buying labels is a Herd feature. Enforce membership server-side
    // after the signed-event + listed-seller checks, before any Shippo charge.
    if (!(await requireProEntitlement(event.pubkey, res))) return;

    // Ownership check: the shipment must have been quoted by /api/shipping/rates
    // with a signed-event header from this same pubkey. This prevents callers
    // from buying labels against a shipment they did not quote.
    const owner = await getShipmentOwner(shipmentId);
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

    // Single-use: burn this signed proof before any charge so a captured event
    // cannot be replayed to buy another label within its freshness window.
    if (!(await consumeSignedRequestProof(event, "shipping_buy_label"))) {
      return res
        .status(401)
        .json({ error: "Signed event has already been used." });
    }

    // Atomically claim this shipment in the shared registry so two concurrent
    // requests (even across different server instances) can never both buy the
    // same label (a duplicate charge). The claim is released below if the
    // purchase cannot be completed, so the seller can retry.
    if (!(await claimShipmentForPurchase(shipmentId, event.pubkey))) {
      return res
        .status(409)
        .json({ error: "Shipment label already purchased" });
    }

    // Order-level claim — SHARED with the auto-purchase (webhook/MCP) paths,
    // so a dashboard click and an agent/webhook purchase can never both
    // charge for the same order. The shipment id is attached up front so an
    // ambiguous charge can later be reconciled against Shippo.
    let orderClaimKey: string | null = null;
    let orderReconcileToken: string | null = null;
    if (orderId) {
      orderClaimKey = `outbound:${event.pubkey}:${orderId}`;
      // Fixed-length token persisted on the claim and stamped into the Shippo
      // transaction metadata (raw claim keys exceed the 100-char limit), so a
      // lost purchase response can be reconciled against the provider.
      orderReconcileToken = buildLabelReconcileToken(orderClaimKey);
      let wonOrderClaim = await claimAutoLabelPurchase(
        orderClaimKey,
        event.pubkey,
        orderId,
        shipmentId,
        orderReconcileToken
      );
      if (!wonOrderClaim) {
        // A claim already exists: reconcile it against Shippo before
        // deciding. A lost-but-successful earlier charge resolves to
        // already-bought; a stale claim with NO Shippo transaction is
        // released and this attempt proceeds.
        const reconcileToken = await getShippoAccessToken(event.pubkey).catch(
          () => null
        );
        const resolution = await resolveOrderLabelClaimConflict({
          accessToken: reconcileToken,
          claimKey: orderClaimKey,
          pubkey: event.pubkey,
          orderId,
        });
        if (resolution === "retry-safe") {
          wonOrderClaim = await claimAutoLabelPurchase(
            orderClaimKey,
            event.pubkey,
            orderId,
            shipmentId,
            orderReconcileToken
          );
        }
        if (!wonOrderClaim) {
          await releaseShipmentClaim(shipmentId);
          return res.status(409).json({
            error:
              resolution === "already-bought"
                ? "A label was already purchased for this order."
                : "A label purchase for this order is already in progress. Retry in a couple of minutes.",
          });
        }
      }
    }

    try {
      // Resolve the seller's own connected Shippo account. Shippo bills the
      // seller directly, so there is no platform spend cap to enforce.
      const accessToken = await getShippoAccessToken(event.pubkey);
      if (!accessToken) {
        await releaseShipmentClaim(shipmentId);
        if (orderClaimKey) await releaseAutoLabelClaim(orderClaimKey);
        return res.status(409).json({
          error:
            "Connect your Shippo account in Settings → Shipping before buying labels.",
        });
      }

      const label = await buyLabel(accessToken, {
        shipmentId,
        rateId,
        insuranceAmount,
        // Stamped onto the Shippo transaction so a lost response can be
        // reconciled (transactions carry no shipment id).
        metadata: orderReconcileToken ?? undefined,
      });

      // Purchase succeeded — promote the order claim to the permanent
      // 'purchased' marker so no path can ever buy a second label.
      if (orderClaimKey) {
        try {
          await markAutoLabelPurchased(orderClaimKey, label.shipmentId);
        } catch (markErr) {
          // Never throw after the charge: the history row + unique index +
          // reconciliation still guard a retry.
          console.error(
            "CRITICAL: label purchased but order claim not marked:",
            { orderClaimKey, markErr }
          );
        }
      }
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
      // Ambiguous failure: the charge may have landed despite the throw. The
      // ORDER claim is deliberately HELD — a retry reconciles it against
      // Shippo (resolveOrderLabelClaimConflict) and is only allowed to buy
      // once Shippo proves no charge exists.
      await releaseShipmentClaim(shipmentId);
      throw buyErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Buy shipping label failed:", message);
    return res.status(500).json({ error: message });
  }
}
