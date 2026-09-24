import {
  claimOutboundLabelPurchase,
  claimShipmentForPurchase,
  insertShippingLabel,
  markOutboundLabelPurchased,
  releaseOutboundLabelClaim,
  releaseShipmentClaim,
} from "@/utils/db/shipping-service";
import {
  buyLabel,
  isDefinitiveShippoPurchaseFailure,
} from "@/utils/shipping/shippo";

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
  const claimed =
    input.paymentRef === undefined
      ? await claimOutboundLabelPurchase(input.sellerPubkey, input.orderId)
      : await claimOutboundLabelPurchase(
          input.sellerPubkey,
          input.orderId,
          input.paymentRef
        );
  if (!claimed) return { status: "order-already-claimed" };

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

  let label: PurchasedLabel;
  try {
    label = await buyLabel(input.accessToken, {
      shipmentId: input.shipmentId,
      rateId: input.rateId,
      insuranceAmount: input.insuranceAmount,
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
