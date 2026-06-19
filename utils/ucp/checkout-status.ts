/**
 * Pure (DB-free) status lifecycle + input helpers for UCP checkout sessions.
 *
 * Kept separate from `checkout-store.ts` (which pulls in the Postgres pool) so
 * the lifecycle mapping and the variant-id decoder can be unit-tested directly,
 * and so the REST route and the store share ONE source of truth for the status
 * names. The status names follow the UCP checkout lifecycle:
 *
 *   incomplete → ready_for_complete → complete_in_progress → completed
 *
 * plus the two off-ramp states `requires_escalation` (a problem the buyer/seller
 * must resolve out of band — e.g. a payment failure or a missing exchange rate)
 * and `canceled` (refunded/cancelled). There is no parallel order state machine:
 * once an order exists, the session status is reconciled against the canonical
 * `mcp_orders.payment_status`.
 */

export type CheckoutSessionStatus =
  | "incomplete"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "requires_escalation"
  | "canceled";

/** All valid statuses, in lifecycle order — used for the DB CHECK + JSON Schema. */
export const CHECKOUT_STATUSES: CheckoutSessionStatus[] = [
  "incomplete",
  "ready_for_complete",
  "complete_in_progress",
  "completed",
  "requires_escalation",
  "canceled",
];

/** Statuses from which the session never advances again (no reconcile needed). */
export const TERMINAL_CHECKOUT_STATUSES: CheckoutSessionStatus[] = [
  "completed",
  "canceled",
];

/**
 * Map the canonical order payment status onto the checkout session lifecycle.
 * Returns the new status, or the current status when the order has not advanced
 * (so a still-pending invoice keeps its `ready_for_complete` state).
 */
export function reconcileStatusFromOrder(
  current: CheckoutSessionStatus,
  paymentStatus: string | null | undefined
): CheckoutSessionStatus {
  switch (paymentStatus) {
    case "paid":
      return "completed";
    case "processing":
      return "complete_in_progress";
    case "failed":
      return "requires_escalation";
    case "refunded":
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return current;
  }
}

export type DecodedVariant =
  | {
      ok: true;
      selectedSize?: string;
      selectedVolume?: string;
      selectedWeight?: string;
    }
  | { ok: false; error: string };

/**
 * Decode a catalog variant id (as emitted by `utils/ucp/catalog.ts`) into the
 * order-engine selection fields. The catalog uses the prefixes `size:`,
 * `volume:`, `weight:` for priced/inventoried variants and `variant:` for
 * descriptive-only options (no price/inventory of their own). A descriptive
 * `variant:` id decodes to no selection — it is accepted but does not change the
 * order. Anything else is rejected so a bogus id can't silently buy the base
 * product.
 */
export function decodeVariantId(variantId: string): DecodedVariant {
  const raw = (variantId || "").trim();
  if (!raw) return { ok: false, error: "variantId is empty." };
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    return {
      ok: false,
      error: `Unrecognized variantId "${variantId}". Expected "<dimension>:<value>" (e.g. "size:1 Gallon").`,
    };
  }
  const dimension = raw.slice(0, idx).toLowerCase();
  const value = raw.slice(idx + 1).trim();
  if (!value) {
    return { ok: false, error: `variantId "${variantId}" is missing a value.` };
  }
  switch (dimension) {
    case "size":
      return { ok: true, selectedSize: value };
    case "volume":
      return { ok: true, selectedVolume: value };
    case "weight":
      return { ok: true, selectedWeight: value };
    case "variant":
      // Descriptive-only variant: no price/inventory dimension to select.
      return { ok: true };
    default:
      return {
        ok: false,
        error: `Unknown variant dimension "${dimension}" in variantId "${variantId}".`,
      };
  }
}
