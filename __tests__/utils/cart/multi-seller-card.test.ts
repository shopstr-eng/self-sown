/**
 * Multi-seller sequential card flow: when step N's charge settles but setting
 * up step N+1's card form throws, the paid seller's order effects must ALREADY
 * have fired, the buyer must see the retry-the-remaining-sellers message, and
 * the recorded results must let a resubmit skip the paid seller (never
 * double-charge).
 */
import {
  buildMultiCardQueue,
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
