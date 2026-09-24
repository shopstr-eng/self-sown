// Checkout-time shipping binding for the web card auto-label-purchase routes.
//
// Threat model: the auto-purchase endpoints (pages/api/shipping/auto-purchase*.ts)
// are unauthenticated — their only authorization is a re-verified, SETTLED card
// payment. If the order, product (parcel profile), or destination came from the
// post-payment request body, a buyer holding any settled payment for a seller
// could trigger one seller-billed label to an ARBITRARY address (pay cheap
// shipping to A, ship the label to expensive B) against an arbitrary parcel.
//
// So the payment-creation routes (Stripe create-payment-intent, Square
// create-payment) persist the buyer's checkout data server-side, keyed by the
// provider-issued payment id, and the auto-purchase routes derive everything
// from that record after re-verifying settlement. This module is the shared,
// dependency-free contract between those routes (and the checkout client):
// payment-ref builders plus input sanitizers. Persistence lives in
// utils/db/shipping-service.ts.

import type { ShippingAddressInput } from "@/utils/shipping/types";

export interface ShippingCheckoutContext {
  sellerPubkey: string;
  orderId: string;
  productId: string;
  toAddress: ShippingAddressInput;
}

// Payment refs are provider-namespaced so a Square payment id and a Stripe
// PaymentIntent id can never collide in the shared table.
export function stripeCheckoutRef(paymentIntentId: string): string {
  return `stripe:${paymentIntentId}`;
}

export function squareCheckoutRef(paymentId: string): string {
  return `square:${paymentId}`;
}

// Hard bounds on buyer-supplied context payloads (per payment).
const MAX_CONTEXTS_PER_PAYMENT = 25;
const MAX_ID_LEN = 200;
const MAX_LONG_FIELD = 300;
const MAX_SHORT_FIELD = 100;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Validate + normalize a checkout destination. Returns null unless every
 * field a US label rate/address needs is present (mirrors the eligibility
 * gate in runAutoLabelPurchase); over-long or non-string input is rejected
 * rather than truncated into a silently different address.
 */
export function sanitizeToAddress(raw: unknown): ShippingAddressInput | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const street1 = boundedString(a.street1, MAX_LONG_FIELD);
  const city = boundedString(a.city, MAX_SHORT_FIELD);
  const state = boundedString(a.state, MAX_SHORT_FIELD);
  const zip = boundedString(a.zip, 40);
  const country = boundedString(a.country, 56);
  if (!street1 || !city || !state || !zip || !country) return null;
  return {
    name: optionalString(a.name, MAX_ID_LEN),
    street1,
    street2: optionalString(a.street2, MAX_LONG_FIELD),
    city,
    state,
    zip,
    country,
    email: optionalString(a.email, 254),
  };
}

/**
 * Validate one checkout context against the set of sellers THIS payment
 * actually charges (server-verified at creation: the validated split pubkeys
 * for a multi-merchant intent, or the metadata seller whose account the
 * direct charge lands on). A context naming any other seller is dropped, so
 * a buyer can never plant a destination/product binding for a seller who
 * never sees this money.
 */
export function sanitizeCheckoutContext(
  raw: unknown,
  allowedSellerPubkeys: ReadonlySet<string>
): ShippingCheckoutContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const sellerPubkey = boundedString(c.sellerPubkey, 128);
  if (!sellerPubkey || !allowedSellerPubkeys.has(sellerPubkey)) return null;
  const orderId = boundedString(c.orderId, MAX_ID_LEN);
  const productId = boundedString(c.productId, MAX_ID_LEN);
  const toAddress = sanitizeToAddress(c.toAddress);
  if (!orderId || !productId || !toAddress) return null;
  return { sellerPubkey, orderId, productId, toAddress };
}

/**
 * Validate a context list for one payment: count-capped, one context per
 * seller (first valid wins). Invalid entries are dropped individually — a
 * malformed context must never fail the buyer's payment, it just means the
 * auto-label purchase later skips and the seller buys the label manually.
 */
export function sanitizeCheckoutContexts(
  raw: unknown,
  allowedSellerPubkeys: ReadonlySet<string>
): ShippingCheckoutContext[] {
  if (!Array.isArray(raw)) return [];
  const out: ShippingCheckoutContext[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_CONTEXTS_PER_PAYMENT)) {
    const ctx = sanitizeCheckoutContext(entry, allowedSellerPubkeys);
    if (ctx && !seen.has(ctx.sellerPubkey)) {
      seen.add(ctx.sellerPubkey);
      out.push(ctx);
    }
  }
  return out;
}
