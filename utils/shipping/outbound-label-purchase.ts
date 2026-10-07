import {
  attachShipmentToClaim,
  claimOutboundLabelPurchase,
  claimShipmentForPurchase,
  insertShippingLabel,
  markOutboundLabelPurchased,
  releaseAutoLabelClaim,
  releaseOutboundLabelClaim,
  releaseShipmentClaim,
} from "@/utils/db/shipping-service";
import {
  buyLabel,
  isDefinitiveShippoPurchaseFailure,
} from "@/utils/shipping/shippo";
import {
  buildLabelReconcileToken,
  resolveOrderLabelClaimConflict,
} from "@/utils/shipping/claim-reconcile";

interface PurchaseOutboundLabelInput {
  sellerPubkey: string;
  orderId: string;
  accessToken: string;
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
  paymentRef?: string | null;
  claimShipment?: boolean;
  fromSummary?: string | null;
  toSummary?: string | null;
  parcelSummary?: string | null;
}

type PurchasedLabel = Awaited<ReturnType<typeof buyLabel>>;

export type PurchaseOutboundLabelResult =
  | { status: "order-already-claimed" }
  | { status: "shipment-already-claimed" }
  | { status: "uncertain" }
  | {
      status: "purchased";
      label: PurchasedLabel;
      labelId: number | null;
    };

export async function purchaseOutboundLabel(
  input: PurchaseOutboundLabelInput
): Promise<PurchaseOutboundLabelResult> {
  // The legacy shipping_label_order_claims key this attempt dual-writes.
  // Shared with the claimKey-based auto-purchase paths, so a claim taken by
  // either system blocks the other.
  const legacyClaimKey =
    input.paymentRef || `outbound:${input.sellerPubkey}:${input.orderId}`;

  let claimed = await claimOutboundLabelPurchase(
    input.sellerPubkey,
    input.orderId,
    input.paymentRef ?? null
  );
  if (!claimed) {
    // A claim already exists: reconcile it against Shippo before deciding. A
    // lost-but-successful earlier charge resolves to already-bought; a stale
    // claim with NO Shippo transaction is released and this attempt proceeds.
    const resolution = await resolveOrderLabelClaimConflict({
      accessToken: input.accessToken,
      claimKey: legacyClaimKey,
      pubkey: input.sellerPubkey,
      orderId: input.orderId,
    });
    if (resolution === "retry-safe") {
      // The legacy row was released by the reconciliation; drop any orphaned
      // pending row in the outbound table too, then re-claim once.
      await releaseOutboundLabelClaim(input.sellerPubkey, input.orderId);
      claimed = await claimOutboundLabelPurchase(
        input.sellerPubkey,
        input.orderId,
        input.paymentRef ?? null
      );
    }
    if (!claimed) return { status: "order-already-claimed" };
  }

  if (
    input.claimShipment &&
    !(await claimShipmentForPurchase(
      input.shipmentId,
      input.sellerPubkey,
      input.orderId
    ))
  ) {
    await releaseOutboundLabelClaim(input.sellerPubkey, input.orderId);
    return { status: "shipment-already-claimed" };
  }

  // Attach the Shippo shipment id AND reconciliation token to the legacy claim
  // BEFORE the non-idempotent charge, so an ambiguous buyLabel failure (a
  // timeout after Shippo accepted) can later be reconciled against Shippo's
  // transaction list (matched by the token stamped into the transaction
  // metadata). A false return means the claim row vanished or was already
  // resolved — do NOT charge without this reconciliation handle.
  const reconcileToken = buildLabelReconcileToken(legacyClaimKey);
  const attached = await attachShipmentToClaim(
    legacyClaimKey,
    input.shipmentId,
    reconcileToken
  );
  if (!attached) {
    await Promise.all([
      ...(input.claimShipment ? [releaseShipmentClaim(input.shipmentId)] : []),
      releaseOutboundLabelClaim(input.sellerPubkey, input.orderId),
      releaseAutoLabelClaim(legacyClaimKey),
    ]);
    throw new Error(
      "Label purchase claim lost before charge; refusing to buy without a reconciliation handle"
    );
  }

  let label: PurchasedLabel;
  try {
    label = await buyLabel(input.accessToken, {
      shipmentId: input.shipmentId,
      rateId: input.rateId,
      insuranceAmount: input.insuranceAmount,
      // Stamped onto the Shippo transaction so a lost response can be
      // reconciled (transactions carry no shipment id).
      metadata: reconcileToken,
    });
  } catch (error) {
    if (isDefinitiveShippoPurchaseFailure(error)) {
      await Promise.all([
        ...(input.claimShipment
          ? [releaseShipmentClaim(input.shipmentId)]
          : []),
        releaseOutboundLabelClaim(input.sellerPubkey, input.orderId),
      ]);
      throw error;
    }
    // Ambiguous failure: the charge may have landed despite the throw. The
    // claims are deliberately HELD — a retry reconciles them against Shippo
    // (resolveOrderLabelClaimConflict) and is only allowed to buy once Shippo
    // proves no charge exists.
    console.error("Shippo label purchase outcome is uncertain", {
      sellerPubkey: input.sellerPubkey,
      orderId: input.orderId,
      shipmentId: input.shipmentId,
      error: error instanceof Error ? error.message : error,
    });
    return { status: "uncertain" };
  }

  try {
    await markOutboundLabelPurchased(
      input.sellerPubkey,
      input.orderId,
      label.shipmentId
    );
  } catch (error) {
    console.error("CRITICAL: label purchased but claim update failed", {
      sellerPubkey: input.sellerPubkey,
      orderId: input.orderId,
      shipmentId: label.shipmentId,
      error,
    });
  }

  let labelId: number | null = null;
  try {
    const record = await insertShippingLabel({
      pubkey: input.sellerPubkey,
      shipmentId: label.shipmentId,
      orderId: input.orderId,
      trackingCode: label.trackingCode || null,
      trackingUrl: label.trackingUrl ?? null,
      labelUrl: label.labelUrl,
      labelFormat: label.labelFormat,
      rateUsd: label.rate,
      currency: label.currency,
      carrier: label.carrier,
      service: label.service,
      isReturn: false,
      fromSummary: input.fromSummary ?? null,
      toSummary: input.toSummary ?? null,
      parcelSummary: input.parcelSummary ?? null,
    });
    labelId = record.id;
  } catch (error) {
    console.error("CRITICAL: label purchased but history insert failed", {
      sellerPubkey: input.sellerPubkey,
      orderId: input.orderId,
      shipmentId: label.shipmentId,
      error,
    });
  }

  return { status: "purchased", label, labelId };
}
