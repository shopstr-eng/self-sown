// Reconciliation for ambiguous Shippo label purchases. The purchase POST is
// not idempotent: a timeout after Shippo accepted the request means the
// seller was charged even though the caller saw a failure. Every outbound
// purchase path (card webhook, MCP agent, manual dashboard) claims the order
// in shipping_label_order_claims BEFORE charging and attaches the Shippo
// shipment id to the claim. A caller that LOSES that claim must not simply
// walk away or blindly retry — this module decides, from Shippo's own
// transaction list, what the claim actually means:
//
//  - already-bought: a SUCCESS transaction exists for the claim's shipment.
//    The charge happened; the claim is promoted to 'purchased' and the label
//    history row is backfilled. NEVER buy again.
//  - retry-safe: the claim is stale (older than any plausible in-flight
//    Shippo POST) AND Shippo shows no successful transaction for its
//    shipment — the charge definitively did not happen. The dead claim is
//    released; the caller should re-claim and proceed.
//  - in-progress: outcome unknown (claim fresh, no shipment attached, or the
//    reconciliation query itself failed). Refuse. Fail-closed on money.

import { createHash } from "crypto";
import {
  getAutoLabelClaim,
  insertShippingLabel,
  markAutoLabelPurchased,
  releaseAutoLabelClaim,
} from "@/utils/db/shipping-service";
import { findSuccessfulTransactionForShipment } from "@/utils/shipping/shippo";

// Shippo calls carry a 10s client timeout; a claim younger than this could
// still have a charge in flight, so only older claims may be released after
// reconciliation finds nothing.
const CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * Shippo limits transaction metadata to 100 characters and claim keys
 * (outbound:<64-char pubkey>:<orderId>) exceed that, so purchases stamp this
 * fixed-length digest instead. The SAME token is persisted on both the order
 * claim and the payment claim of one purchase attempt, so either can
 * reconcile a lost charge.
 */
export function buildLabelReconcileToken(claimKey: string): string {
  return createHash("sha256")
    .update(`shippo-label-reconcile:${claimKey}`)
    .digest("hex");
}

export type OrderLabelClaimResolution =
  | "already-bought"
  | "retry-safe"
  | "in-progress";

export async function resolveOrderLabelClaimConflict(args: {
  accessToken: string | null;
  claimKey: string;
  pubkey: string;
  orderId: string;
}): Promise<OrderLabelClaimResolution> {
  let claim;
  try {
    claim = await getAutoLabelClaim(args.claimKey);
  } catch {
    return "in-progress";
  }
  if (!claim) return "retry-safe"; // released/pruned between conflict and read
  if (claim.status === "purchased") return "already-bought";
  // No shipment attached: every charge path attaches the shipment BEFORE the
  // purchase POST, so a claim still missing one after the stale interval is a
  // crash orphan that never reached Shippo — safe to release. A fresh one may
  // be mid-attempt: refuse.
  if (!claim.shipmentId) {
    if (Date.now() - claim.updatedAtMs < CLAIM_STALE_MS) return "in-progress";
    await releaseAutoLabelClaim(args.claimKey);
    return "retry-safe";
  }
  if (!args.accessToken) return "in-progress";
  // The token stamped into the Shippo transaction metadata at purchase time.
  // A claim attached by code that predates token stamping cannot be matched
  // against the provider — unknown, refuse.
  if (!claim.reconcileToken) return "in-progress";

  let lookup;
  try {
    lookup = await findSuccessfulTransactionForShipment({
      accessToken: args.accessToken,
      shipmentId: claim.shipmentId,
      reconcileToken: claim.reconcileToken,
      // Cover the claim's charge window (attach time, minus a clock-skew
      // buffer) — a scan that never reaches it proves nothing.
      sinceMs: claim.updatedAtMs - 60_000,
    });
  } catch {
    return "in-progress"; // reconciliation unavailable — never guess on money
  }
  const label = lookup.label;

  if (label) {
    // The earlier attempt DID charge. Make the records match reality.
    await markAutoLabelPurchased(args.claimKey, claim.shipmentId);
    try {
      await insertShippingLabel({
        pubkey: args.pubkey,
        shipmentId: label.shipmentId,
        orderId: args.orderId,
        trackingCode: label.trackingCode || null,
        trackingUrl: label.trackingUrl ?? null,
        labelUrl: label.labelUrl,
        labelFormat: label.labelFormat,
        rateUsd: label.rate,
        currency: label.currency,
        carrier: label.carrier,
        service: label.service,
        isReturn: false,
      });
    } catch (dbErr) {
      // The partial unique index on (pubkey, order_id) makes a duplicate
      // history insert fail harmlessly.
      console.error(
        "Label history insert during reconciliation failed:",
        dbErr
      );
    }
    return "already-bought";
  }

  // A transaction stamped with this claim key is still in a nonterminal
  // state — it may become a charge. Never release beneath it.
  if (lookup.hasInFlight) return "in-progress";
  // The scan did not cover the claim's window (high-volume account pushed the
  // transaction past the scanned pages): "not found" proves nothing — refuse.
  if (!lookup.coveredWindow) return "in-progress";
  // No successful transaction for the claim's shipment across the full
  // window: the charge definitively did not happen — but only trust that
  // once the claim is older than any plausible in-flight Shippo POST.
  if (Date.now() - claim.updatedAtMs < CLAIM_STALE_MS) return "in-progress";
  await releaseAutoLabelClaim(args.claimKey);
  return "retry-safe";
}
