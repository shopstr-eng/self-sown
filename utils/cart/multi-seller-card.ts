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

// Per-seller card charge for a multi-seller cart = that seller's items + that
// seller's discounted shipping, in the cart's charge currency (or sats→USD,
// handled server-side, for sats carts). Multi-seller carts carry no
// payment-method discount and no sales tax (both single-seller only), so this
// equals the per-seller amount reported in that seller's order DM/email. The
// native amount is rounded UP to the minor unit so a captured charge never
// under-collects. Pure port of the cart component's `getSellerCardCharge`.
export function computeSellerCardCharge(params: {
  pubkey: string;
  products: { id: string; pubkey: string }[];
  isSatsCart: boolean;
  cartCurrency: string | null | undefined;
  nativeCostsPerProduct: Record<string, number> | null | undefined;
  nativeShippingPerSeller: Record<string, number>;
  totalCostsInSats: Record<string, number>;
  shippingCostsInSats: Record<string, number>;
}): { amount: number; currency: string } {
  const {
    pubkey,
    products,
    isSatsCart,
    cartCurrency,
    nativeCostsPerProduct,
    nativeShippingPerSeller,
    totalCostsInSats,
    shippingCostsInSats,
  } = params;

  const sellerProducts = products.filter((p) => p.pubkey === pubkey);
  const useNative = !isSatsCart && !!cartCurrency;
  if (useNative) {
    const items = sellerProducts.reduce(
      (sum, p) => sum + (nativeCostsPerProduct?.[p.id] || 0),
      0
    );
    const shipping = nativeShippingPerSeller[pubkey] || 0;
    const amount = Math.ceil((items + shipping) * 100) / 100;
    return { amount, currency: (cartCurrency as string).toUpperCase() };
  }

  // Sats cart: each eligible Square seller settles in USD, and Stripe direct
  // charges accept sats. Send the sats total; the server handles conversion.
  const items =
    totalCostsInSats[pubkey] ||
    sellerProducts.reduce((sum, p) => sum + (totalCostsInSats[p.id] || 0), 0);
  const shipping = shippingCostsInSats[pubkey] || 0;
  return { amount: items + shipping, currency: "sats" };
}

// Orchestrates what happens after ONE seller's card charge settles in the
// sequential multi-seller flow. The paid seller is notified FIRST (their order
// DM + auto-ship + order-confirmation email), and only then does the flow
// advance to the next seller or finalize — so a failure setting up the next
// seller's card form (or finalizing) can NEVER suppress the notification for a
// seller who was actually paid. A throw while configuring the next step is
// surfaced via `onAdvanceError` (not rethrown): the previous sellers stay paid
// and a retry resumes from the remaining unpaid sellers.
export async function runMultiCardStepAdvance(params: {
  index: number;
  queueLength: number;
  notifyPaidSeller: () => Promise<void> | void;
  configureNextStep: () => Promise<void>;
  finalizeOrder: () => Promise<void>;
  onAdvanceError: (error: unknown) => void;
}): Promise<void> {
  const {
    index,
    queueLength,
    notifyPaidSeller,
    configureNextStep,
    finalizeOrder,
    onAdvanceError,
  } = params;

  // Notify the just-paid seller before any advance/finalize work.
  await notifyPaidSeller();

  if (!isFinalMultiCardStep(index, queueLength)) {
    try {
      await configureNextStep();
    } catch (error) {
      onAdvanceError(error);
    }
    return;
  }

  await finalizeOrder();
}
