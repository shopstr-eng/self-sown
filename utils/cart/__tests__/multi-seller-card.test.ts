import {
  computeMultiSellerCardEligible,
  buildMultiCardQueue,
  resolveMultiCardOrderId,
  isFinalMultiCardStep,
  computeSellerCardCharge,
  runMultiCardStepAdvance,
  SellerCardProcessor,
  MultiCardResult,
} from "@/utils/cart/multi-seller-card";

const stripeSeller: SellerCardProcessor = {
  processor: "stripe",
  stripeAccountId: "acct_123",
};

const squareSellerUSD: SellerCardProcessor = {
  processor: "square",
  square: {
    applicationId: "app",
    locationId: "loc",
    environment: "production",
    currency: "USD",
  },
};

const squareSellerEUR: SellerCardProcessor = {
  processor: "square",
  square: {
    applicationId: "app",
    locationId: "loc",
    environment: "production",
    currency: "EUR",
  },
};

describe("computeMultiSellerCardEligible", () => {
  const base = {
    isSingleSeller: false,
    hasActiveSubscription: false,
    uniqueSellerPubkeys: ["a", "b"],
    sellerCardProcessors: { a: stripeSeller, b: squareSellerUSD } as Record<
      string,
      SellerCardProcessor | undefined
    >,
    isSatsCart: true,
    cartCurrency: "sats" as string | null | undefined,
  };

  it("is eligible for a mixed Stripe+Square sats cart when the Square seller settles in USD", () => {
    expect(computeMultiSellerCardEligible(base)).toBe(true);
  });

  it("is eligible for a native-currency cart when the Square seller's currency matches", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        isSatsCart: false,
        cartCurrency: "eur",
        sellerCardProcessors: { a: stripeSeller, b: squareSellerEUR },
      })
    ).toBe(true);
  });

  it("fails closed for a single-seller cart", () => {
    expect(
      computeMultiSellerCardEligible({ ...base, isSingleSeller: true })
    ).toBe(false);
  });

  it("fails closed when the cart has an active subscription", () => {
    expect(
      computeMultiSellerCardEligible({ ...base, hasActiveSubscription: true })
    ).toBe(false);
  });

  it("fails closed when there are no sellers", () => {
    expect(
      computeMultiSellerCardEligible({ ...base, uniqueSellerPubkeys: [] })
    ).toBe(false);
  });

  it("fails closed when any seller has no resolved processor", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        sellerCardProcessors: { a: stripeSeller, b: undefined },
      })
    ).toBe(false);
  });

  it("fails closed when no seller is Square (all-Stripe uses the existing flow)", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        sellerCardProcessors: { a: stripeSeller, b: stripeSeller },
      })
    ).toBe(false);
  });

  it("fails closed when a Square seller's location currency is missing", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        sellerCardProcessors: {
          a: stripeSeller,
          b: { processor: "square" },
        },
      })
    ).toBe(false);
  });

  it("fails closed when a sats cart's Square seller does not settle in USD", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        sellerCardProcessors: { a: stripeSeller, b: squareSellerEUR },
      })
    ).toBe(false);
  });

  it("fails closed when a native-currency cart's Square seller currency mismatches", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        isSatsCart: false,
        cartCurrency: "usd",
        sellerCardProcessors: { a: stripeSeller, b: squareSellerEUR },
      })
    ).toBe(false);
  });

  it("fails closed for a native-currency cart with no cart currency", () => {
    expect(
      computeMultiSellerCardEligible({
        ...base,
        isSatsCart: false,
        cartCurrency: null,
        sellerCardProcessors: { a: stripeSeller, b: squareSellerEUR },
      })
    ).toBe(false);
  });
});

describe("buildMultiCardQueue", () => {
  const sellers = ["a", "b", "c"];
  const processors: Record<string, SellerCardProcessor | undefined> = {
    a: stripeSeller,
    b: squareSellerUSD,
    c: stripeSeller,
  };

  it("queues every seller in order when nothing has been paid yet", () => {
    const queue = buildMultiCardQueue(sellers, processors, {});
    expect(queue).toEqual([
      { pubkey: "a", processor: "stripe" },
      { pubkey: "b", processor: "square" },
      { pubkey: "c", processor: "stripe" },
    ]);
  });

  it("skips sellers already charged in a prior attempt (no double-charge on resubmit)", () => {
    const results: Record<string, MultiCardResult> = {
      a: { processor: "stripe", paymentId: "pi_a" },
    };
    const queue = buildMultiCardQueue(sellers, processors, results);
    expect(queue).toEqual([
      { pubkey: "b", processor: "square" },
      { pubkey: "c", processor: "stripe" },
    ]);
  });

  it("returns an empty queue when every seller was already paid", () => {
    const results: Record<string, MultiCardResult> = {
      a: { processor: "stripe", paymentId: "pi_a" },
      b: { processor: "square", paymentId: "pi_b" },
      c: { processor: "stripe", paymentId: "pi_c" },
    };
    expect(buildMultiCardQueue(sellers, processors, results)).toEqual([]);
  });
});

describe("resolveMultiCardOrderId", () => {
  it("reuses an existing order id from a prior partial attempt", () => {
    const generate = jest.fn(() => "fresh-id");
    expect(resolveMultiCardOrderId("existing-id", generate)).toBe(
      "existing-id"
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates a fresh order id only when none exists", () => {
    const generate = jest.fn(() => "fresh-id");
    expect(resolveMultiCardOrderId("", generate)).toBe("fresh-id");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("isFinalMultiCardStep", () => {
  it("treats the last index as final", () => {
    expect(isFinalMultiCardStep(2, 3)).toBe(true);
  });

  it("treats a non-last index as not final (advance to next seller)", () => {
    expect(isFinalMultiCardStep(0, 3)).toBe(false);
    expect(isFinalMultiCardStep(1, 3)).toBe(false);
  });

  it("treats an empty queue as final (all-already-paid resubmit finalizes immediately)", () => {
    expect(isFinalMultiCardStep(0, 0)).toBe(true);
  });
});

describe("end-to-end resubmit invariant", () => {
  it("charges only unpaid sellers across a cancelled-then-resubmitted attempt while reusing one order id", () => {
    const sellers = ["a", "b", "c"];
    const processors: Record<string, SellerCardProcessor | undefined> = {
      a: stripeSeller,
      b: squareSellerUSD,
      c: stripeSeller,
    };
    const results: Record<string, MultiCardResult> = {};

    // First attempt: order id minted once, full queue.
    let orderId = resolveMultiCardOrderId("", () => "order-1");
    const firstQueue = buildMultiCardQueue(sellers, processors, results);
    expect(firstQueue).toHaveLength(3);

    // Buyer pays seller "a", then abandons (cancels mid-sequence).
    results["a"] = { processor: "stripe", paymentId: "pi_a" };

    // Resubmit: SAME order id is reused, and only the unpaid sellers are queued.
    orderId = resolveMultiCardOrderId(orderId, () => "order-2");
    expect(orderId).toBe("order-1");
    const secondQueue = buildMultiCardQueue(sellers, processors, results);
    expect(secondQueue.map((s) => s.pubkey)).toEqual(["b", "c"]);

    // Pay "b" (not final) then "c" (final → finalize).
    expect(isFinalMultiCardStep(0, secondQueue.length)).toBe(false);
    results["b"] = { processor: "square", paymentId: "pi_b" };
    expect(isFinalMultiCardStep(1, secondQueue.length)).toBe(true);
    results["c"] = { processor: "stripe", paymentId: "pi_c" };

    // A further resubmit has nothing left to charge and finalizes immediately.
    const finalQueue = buildMultiCardQueue(sellers, processors, results);
    expect(finalQueue).toEqual([]);
    expect(isFinalMultiCardStep(0, finalQueue.length)).toBe(true);
  });
});

describe("computeSellerCardCharge", () => {
  const products = [
    { id: "p1", pubkey: "a" },
    { id: "p2", pubkey: "a" },
    { id: "p3", pubkey: "b" },
  ];

  it("sums only the seller's own items + that seller's shipping (per-seller isolation)", () => {
    const charge = computeSellerCardCharge({
      pubkey: "a",
      products,
      isSatsCart: false,
      cartCurrency: "usd",
      nativeCostsPerProduct: { p1: 10, p2: 5, p3: 99 },
      nativeShippingPerSeller: { a: 2, b: 7 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    // 10 + 5 items + 2 shipping = 17.00; seller "b"'s p3/shipping excluded.
    expect(charge).toEqual({ amount: 17, currency: "USD" });
  });

  it("rounds the native charge UP to the minor unit so it never under-collects", () => {
    const charge = computeSellerCardCharge({
      pubkey: "a",
      products,
      isSatsCart: false,
      cartCurrency: "eur",
      // 10.005 + 5.001 = 15.006 items + 2.001 shipping = 17.007 → ceil to 17.01.
      nativeCostsPerProduct: { p1: 10.005, p2: 5.001 },
      nativeShippingPerSeller: { a: 2.001 },
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge.amount).toBe(17.01);
    // The cart currency is upper-cased for the charge.
    expect(charge.currency).toBe("EUR");
  });

  it("treats missing per-product/shipping native costs as zero", () => {
    const charge = computeSellerCardCharge({
      pubkey: "a",
      products,
      isSatsCart: false,
      cartCurrency: "usd",
      nativeCostsPerProduct: { p1: 4 }, // p2 missing → 0
      nativeShippingPerSeller: {}, // a missing → 0
      totalCostsInSats: {},
      shippingCostsInSats: {},
    });
    expect(charge).toEqual({ amount: 4, currency: "USD" });
  });

  it("uses the per-seller sats total + sats shipping for a sats cart", () => {
    const charge = computeSellerCardCharge({
      pubkey: "a",
      products,
      isSatsCart: true,
      cartCurrency: "sats",
      nativeCostsPerProduct: null,
      nativeShippingPerSeller: {},
      totalCostsInSats: { a: 1000 },
      shippingCostsInSats: { a: 200 },
    });
    expect(charge).toEqual({ amount: 1200, currency: "sats" });
  });

  it("falls back to summing per-product sats when no per-seller sats total exists", () => {
    const charge = computeSellerCardCharge({
      pubkey: "a",
      products,
      isSatsCart: true,
      cartCurrency: null,
      nativeCostsPerProduct: null,
      nativeShippingPerSeller: {},
      // No "a" key → sum p1 + p2 (both seller "a"); p3 (seller "b") excluded.
      totalCostsInSats: { p1: 300, p2: 400, p3: 9999 },
      shippingCostsInSats: { a: 50 },
    });
    expect(charge).toEqual({ amount: 750, currency: "sats" });
  });
});

describe("runMultiCardStepAdvance", () => {
  function makeSpies() {
    const calls: string[] = [];
    return {
      calls,
      notifyPaidSeller: jest.fn(async () => {
        calls.push("notify");
      }),
      configureNextStep: jest.fn(async () => {
        calls.push("configureNext");
      }),
      finalizeOrder: jest.fn(async () => {
        calls.push("finalize");
      }),
      onAdvanceError: jest.fn((_e: unknown) => {
        calls.push("error");
      }),
    };
  }

  it("notifies the paid seller BEFORE advancing to the next step (non-final)", async () => {
    const s = makeSpies();
    await runMultiCardStepAdvance({
      index: 0,
      queueLength: 2,
      notifyPaidSeller: s.notifyPaidSeller,
      configureNextStep: s.configureNextStep,
      finalizeOrder: s.finalizeOrder,
      onAdvanceError: s.onAdvanceError,
    });
    expect(s.calls).toEqual(["notify", "configureNext"]);
    expect(s.finalizeOrder).not.toHaveBeenCalled();
    expect(s.onAdvanceError).not.toHaveBeenCalled();
  });

  it("finalizes (not configureNext) on the final step, after notifying the seller", async () => {
    const s = makeSpies();
    await runMultiCardStepAdvance({
      index: 1,
      queueLength: 2,
      notifyPaidSeller: s.notifyPaidSeller,
      configureNextStep: s.configureNextStep,
      finalizeOrder: s.finalizeOrder,
      onAdvanceError: s.onAdvanceError,
    });
    expect(s.calls).toEqual(["notify", "finalize"]);
    expect(s.configureNextStep).not.toHaveBeenCalled();
  });

  it("keeps the paid seller notified and does NOT finalize when the next step's setup throws", async () => {
    const s = makeSpies();
    const boom = new Error("card form boom");
    s.configureNextStep.mockImplementation(async () => {
      s.calls.push("configureNext");
      throw boom;
    });
    await runMultiCardStepAdvance({
      index: 0,
      queueLength: 2,
      notifyPaidSeller: s.notifyPaidSeller,
      configureNextStep: s.configureNextStep,
      finalizeOrder: s.finalizeOrder,
      onAdvanceError: s.onAdvanceError,
    });
    // Seller was notified, the setup failure was surfaced (not thrown), and the
    // order was NOT finalized — a retry resumes from the remaining sellers.
    expect(s.calls).toEqual(["notify", "configureNext", "error"]);
    expect(s.onAdvanceError).toHaveBeenCalledWith(boom);
    expect(s.finalizeOrder).not.toHaveBeenCalled();
  });

  it("attempts the seller notification first; a notify failure halts the advance", async () => {
    const s = makeSpies();
    s.notifyPaidSeller.mockImplementation(async () => {
      s.calls.push("notify");
      throw new Error("notify boom");
    });
    await expect(
      runMultiCardStepAdvance({
        index: 0,
        queueLength: 2,
        notifyPaidSeller: s.notifyPaidSeller,
        configureNextStep: s.configureNextStep,
        finalizeOrder: s.finalizeOrder,
        onAdvanceError: s.onAdvanceError,
      })
    ).rejects.toThrow("notify boom");
    expect(s.calls).toEqual(["notify"]);
    expect(s.configureNextStep).not.toHaveBeenCalled();
    expect(s.finalizeOrder).not.toHaveBeenCalled();
  });
});
