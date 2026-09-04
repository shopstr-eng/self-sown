/**
 * Multi-seller sequential card flow: when step N's charge settles but setting
 * up step N+1's card form throws, the paid seller's order effects must ALREADY
 * have fired, the buyer must see the retry-the-remaining-sellers message, and
 * the recorded results must let a resubmit skip the paid seller (never
 * double-charge).
 */
import {
  buildMultiCardQueue,
  computeSellerCardCharge,
  isFinalMultiCardStep,
  multiCardAdvanceFailureMessage,
  runMultiCardStepAdvance,
} from "@/utils/cart/multi-seller-card";

const SELLER_A = "a".repeat(64);
const SELLER_B = "b".repeat(64);

describe("runMultiCardStepAdvance", () => {
  it("notifies the paid seller BEFORE a failing next-step configure, surfaces the error, and does not rethrow", async () => {
    const calls: string[] = [];
    await expect(
      runMultiCardStepAdvance({
        index: 0,
        queueLength: 2,
        notifyPaidSeller: async () => {
          calls.push("notify");
        },
        configureNextStep: async () => {
          calls.push("configure");
          throw new Error("stripe.js failed to load");
        },
        finalizeOrder: async () => {
          calls.push("finalize");
        },
        onAdvanceError: (error) => {
          calls.push(
            "error:" + (error instanceof Error ? error.message : "?")
          );
        },
      })
    ).resolves.toBeUndefined();
    // The paid seller's effects fired BEFORE the failed configure, the
    // failure surfaced via onAdvanceError, and finalize was never reached.
    expect(calls).toEqual([
      "notify",
      "configure",
      "error:stripe.js failed to load",
    ]);
  });

  it("advances cleanly when the next step configures", async () => {
    const calls: string[] = [];
    await runMultiCardStepAdvance({
      index: 0,
      queueLength: 2,
      notifyPaidSeller: () => void calls.push("notify"),
      configureNextStep: async () => {
        calls.push("configure");
      },
      finalizeOrder: async () => {
        calls.push("finalize");
      },
      onAdvanceError: () => void calls.push("error"),
    });
    expect(calls).toEqual(["notify", "configure"]);
  });

  it("finalizes instead of configuring on the last step", async () => {
    const calls: string[] = [];
    await runMultiCardStepAdvance({
      index: 1,
      queueLength: 2,
      notifyPaidSeller: () => void calls.push("notify"),
      configureNextStep: async () => {
        calls.push("configure");
      },
      finalizeOrder: async () => {
        calls.push("finalize");
      },
      onAdvanceError: () => void calls.push("error"),
    });
    expect(calls).toEqual(["notify", "finalize"]);
  });

  it("isFinalMultiCardStep boundary", () => {
    expect(isFinalMultiCardStep(0, 2)).toBe(false);
    expect(isFinalMultiCardStep(1, 2)).toBe(true);
  });
});

describe("buildMultiCardQueue — resubmit skips paid sellers", () => {
  it("excludes sellers already recorded in the results ref", () => {
    const queue = buildMultiCardQueue(
      [SELLER_A, SELLER_B],
      {
        [SELLER_A]: { processor: "stripe" },
        [SELLER_B]: {
          processor: "square",
          square: {
            applicationId: "app",
            locationId: "loc",
            environment: "sandbox",
            currency: "USD",
          },
        },
      },
      // Seller A was charged in the prior (failed-at-step-2) attempt.
      { [SELLER_A]: { processor: "stripe", paymentId: "pi_paid" } }
    );
    expect(queue).toEqual([{ pubkey: SELLER_B, processor: "square" }]);
  });
});

describe("multiCardAdvanceFailureMessage", () => {
  it("tells the buyer previous sellers were paid and to retry the remaining ones", () => {
    // Exact copy: this is the buyer-facing recovery instruction, pinned
    // verbatim so a wording/punctuation regression fails loudly.
    expect(multiCardAdvanceFailureMessage("stripe.js failed to load")).toBe(
      "Your previous sellers were paid, but setting up the next seller's card form failed: stripe.js failed to load. Please retry to finish the remaining sellers."
    );
  });
});

describe("computeSellerCardCharge", () => {
  const products = [
    { id: "p1", pubkey: SELLER_A },
    { id: "p2", pubkey: SELLER_A },
    { id: "p3", pubkey: SELLER_B },
  ];

  it("native cart: own items + per-seller shipping, rounded UP to the cent, currency uppercased", () => {
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products,
      isSatsCart: false,
      cartCurrency: "usd",
      nativeCostsPerProduct: { p1: 10.001, p2: 2.002, p3: 99.99 },
      nativeShippingPerSeller: { [SELLER_A]: 1.005 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    // (10.001 + 2.002) + 1.005 = 13.008 -> ceil to the cent; seller B's p3
    // (99.99) must NOT leak into seller A's charge.
    expect(charge).toEqual({ amount: 13.01, currency: "USD" });
  });

  it("native cart: an exact-cent total is not over-rounded", () => {
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products,
      isSatsCart: false,
      cartCurrency: "USD",
      nativeCostsPerProduct: { p1: 10, p2: 5, p3: 99.99 },
      nativeShippingPerSeller: { [SELLER_A]: 0 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge).toEqual({ amount: 15, currency: "USD" });
  });

  it("native cart: a decimal exact-cent total is not floated up a cent", () => {
    // 0.10 + 0.20 = 0.30000000000000004 in IEEE-754 — a naive
    // Math.ceil(x * 100) turns that into 31 cents and OVERCHARGES the buyer.
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products: [
        { id: "d1", pubkey: SELLER_A },
        { id: "d2", pubkey: SELLER_A },
      ],
      isSatsCart: false,
      cartCurrency: "USD",
      nativeCostsPerProduct: { d1: 0.1, d2: 0.2 },
      nativeShippingPerSeller: { [SELLER_A]: 0 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge).toEqual({ amount: 0.3, currency: "USD" });
  });

  it("native cart: a genuine sub-cent fraction still rounds UP (ceil, not nearest)", () => {
    // 13.001 is 1300.1 cents — nearest-cent would UNDER-collect at 13.00.
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products: [{ id: "frac", pubkey: SELLER_A }],
      isSatsCart: false,
      cartCurrency: "USD",
      nativeCostsPerProduct: { frac: 13.001 },
      nativeShippingPerSeller: { [SELLER_A]: 0 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge).toEqual({ amount: 13.01, currency: "USD" });
  });

  it("native cart: missing cost and shipping entries contribute 0", () => {
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products: [{ id: "p-unknown", pubkey: SELLER_A }],
      isSatsCart: false,
      cartCurrency: "EUR",
      nativeCostsPerProduct: {},
      nativeShippingPerSeller: {},
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge).toEqual({ amount: 0, currency: "EUR" });
  });

  it("sats cart: per-seller sats aggregate + sats shipping, no cent rounding", () => {
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products,
      isSatsCart: true,
      cartCurrency: null,
      nativeCostsPerProduct: { p1: 10, p2: 5 },
      nativeShippingPerSeller: { [SELLER_A]: 3 },
      totalCostsInSats: { [SELLER_A]: 5000 },
      shippingCostsInSats: { [SELLER_A]: 250 },
    });
    expect(charge).toEqual({ amount: 5250, currency: "sats" });
  });

  it("sats cart: falls back to summing per-product sats when the seller aggregate is missing", () => {
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products,
      isSatsCart: true,
      cartCurrency: undefined,
      nativeCostsPerProduct: null,
      nativeShippingPerSeller: {},
      totalCostsInSats: { p1: 100, p2: 200, p3: 999 },
      shippingCostsInSats: {},
    });
    // 100 + 200 (own products only); no seller-level aggregate or shipping.
    expect(charge).toEqual({ amount: 300, currency: "sats" });
  });

  it("non-sats cart WITHOUT a currency still takes the sats branch", () => {
    // useNative requires both !isSatsCart AND a currency — a fiat-priced cart
    // with an unresolved currency must not fabricate a native charge.
    const charge = computeSellerCardCharge({
      pubkey: SELLER_A,
      products,
      isSatsCart: false,
      cartCurrency: null,
      nativeCostsPerProduct: { p1: 10, p2: 5 },
      nativeShippingPerSeller: { [SELLER_A]: 3 },
      totalCostsInSats: { [SELLER_A]: 700 },
      shippingCostsInSats: { [SELLER_A]: 30 },
    });
    expect(charge).toEqual({ amount: 730, currency: "sats" });
  });
});
