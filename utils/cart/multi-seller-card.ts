// Pure, testable orchestration helpers for the sequential per-seller card
// checkout used by multi-seller carts that include a Square seller. The
// stateful wiring (refs, React state, network calls) lives in
// `components/cart-invoice-card.tsx`; these helpers capture the invariants that
// keep a buyer from being double-charged or stranded:
//   - eligibility fails closed when any seller lacks a usable processor or a
//     Square seller's settlement currency doesn't match the cart's charge
//     currency;
//   - the charge queue skips sellers already paid in a prior (cancelled)
//     attempt, so a resubmit never re-charges them;
//   - one shared order id is reused across every seller's DMs/emails/receipts;
//   - the final step (and an all-already-paid resubmit) finalizes the order.

export type SellerCardProcessor = {
  processor: "stripe" | "square";
  stripeAccountId?: string;
  square?: {
    applicationId: string;
    locationId: string;
    environment: "sandbox" | "production";
    currency: string;
  };
};

export type MultiCardStep = { pubkey: string; processor: "stripe" | "square" };

export type MultiCardResult = {
  processor: "stripe" | "square";
  paymentId: string;
};

// Whether the sequential per-seller card flow should be offered. Mirrors the
// `multiSellerCardEligible` memo in the cart component. Fails closed: returns
// false unless EVERY seller resolves to a processor, at least one is Square,
// and every Square seller's settlement currency matches the cart's charge
// currency (USD for sats carts; the server converts sats→USD).
export function computeMultiSellerCardEligible(params: {
  isSingleSeller: boolean;
  hasActiveSubscription: boolean;
  uniqueSellerPubkeys: string[];
  sellerCardProcessors: Record<string, SellerCardProcessor | undefined>;
  isSatsCart: boolean;
  cartCurrency: string | null | undefined;
}): boolean {
  const {
    isSingleSeller,
    hasActiveSubscription,
    uniqueSellerPubkeys,
    sellerCardProcessors,
    isSatsCart,
    cartCurrency,
  } = params;

  if (isSingleSeller) return false;
  if (hasActiveSubscription) return false;
  if (uniqueSellerPubkeys.length === 0) return false;

  const entries = uniqueSellerPubkeys.map((pk) => sellerCardProcessors[pk]);
  // Fail closed: every seller must be resolved to a processor.
  if (entries.some((e) => !e)) return false;

  const hasSquare = entries.some((e) => e!.processor === "square");
  if (!hasSquare) return false;

  // Every Square seller's settlement currency must match the cart's charge
  // currency (USD for sats carts; the server converts sats→USD).
  for (const e of entries) {
    if (e!.processor !== "square") continue;
    const loc = e!.square?.currency;
    if (!loc) return false;
    if (isSatsCart) {
      if (loc !== "USD") return false;
    } else {
      if (!cartCurrency) return false;
      if (cartCurrency.toUpperCase() !== loc) return false;
    }
  }

  return true;
}

// Build the ordered queue of sellers still to charge, skipping any seller
// already paid in a prior (cancelled) attempt. Reusing the accumulated results
// is what makes a resubmit charge ONLY the unpaid sellers.
export function buildMultiCardQueue(
  uniqueSellerPubkeys: string[],
  sellerCardProcessors: Record<string, SellerCardProcessor | undefined>,
  results: Record<string, MultiCardResult>
): MultiCardStep[] {
  return uniqueSellerPubkeys
    .filter((pk) => !results[pk])
    .map((pk) => ({
      pubkey: pk,
      processor: sellerCardProcessors[pk]!.processor,
    }));
}

// Reuse the order id from a prior partial attempt so per-step DMs, emails, and
// buyer receipts all line up under one order. Only generate a fresh id when
// none exists yet.
export function resolveMultiCardOrderId(
  existing: string,
  generate: () => string
): string {
  return existing || generate();
}

// The final step finalizes the whole order (and an all-already-paid resubmit,
// where the queue is empty, finalizes immediately).
export function isFinalMultiCardStep(
  index: number,
  queueLength: number
): boolean {
  return index + 1 >= queueLength;
}
