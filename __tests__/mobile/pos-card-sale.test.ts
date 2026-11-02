/** @jest-environment node */

// Retry-safety contract for the Tap to Pay charge: a new charge may only be
// started when Stripe confirms the previous attempt did NOT capture. An
// ambiguous confirm failure must surface as unknown-outcome so the screen can
// block "Try again" instead of risking a double charge.

import {
  canRetryCardPayment,
  executeCardPayment,
  type CardPaymentOps,
} from "../../apps/mobile/lib/pos-card-sale";

type Intent = { status: string };

function makeOps(overrides: {
  retrieveSequence?: Array<{ intent: Intent } | { error: string } | "reject">;
  collectError?: string;
  confirmError?: string;
}): CardPaymentOps<Intent> {
  const retrieveSequence = [...(overrides.retrieveSequence ?? [])];
  return {
    retrievePaymentIntent: jest.fn(async () => {
      const next = retrieveSequence.shift();
      if (next === "reject") throw new Error("network down");
      if (!next) return { error: { message: "no more responses queued" } };
      if ("error" in next) return { error: { message: next.error } };
      return { paymentIntent: next.intent };
    }),
    collectPaymentMethod: jest.fn(async ({ paymentIntent }) =>
      overrides.collectError
        ? { error: { message: overrides.collectError } }
        : { paymentIntent }
    ),
    confirmPaymentIntent: jest.fn(async ({ paymentIntent }) =>
      overrides.confirmError
        ? { error: { message: overrides.confirmError } }
        : { paymentIntent: { ...paymentIntent, status: "succeeded" } }
    ),
    statusOf: (intent) => intent.status,
  };
}

it("approves a cleanly confirmed payment", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [{ intent: { status: "requiresConfirmation" } }],
    }),
    "pi_secret"
  );
  expect(result).toEqual({ kind: "approved" });
  expect(canRetryCardPayment(result)).toBe(false);
});

it("treats a collect failure as not approved — retry is safe", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [{ intent: { status: "requiresPaymentMethod" } }],
      collectError: "The card was declined.",
    }),
    "pi_secret"
  );
  expect(result.kind).toBe("not-approved");
  expect(canRetryCardPayment(result)).toBe(true);
});

it("treats a confirm failure with a canceled intent as not approved", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [
        { intent: { status: "requiresConfirmation" } },
        { intent: { status: "canceled" } },
      ],
      confirmError: "declined",
    }),
    "pi_secret"
  );
  expect(result.kind).toBe("not-approved");
  expect(canRetryCardPayment(result)).toBe(true);
});

it("recovers as approved when the recheck shows the charge succeeded", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [
        { intent: { status: "requiresConfirmation" } },
        { intent: { status: "succeeded" } },
      ],
      confirmError: "network dropped after capture",
    }),
    "pi_secret"
  );
  expect(result).toEqual({ kind: "approved" });
});

it("reports unknown-outcome (no retry) when the recheck shows an in-flight status", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [
        { intent: { status: "requiresConfirmation" } },
        { intent: { status: "processing" } },
      ],
      confirmError: "timeout",
    }),
    "pi_secret"
  );
  expect(result.kind).toBe("unknown-outcome");
  expect(canRetryCardPayment(result)).toBe(false);
});

it("reports unknown-outcome (no retry) when the recheck itself fails", async () => {
  const rejecting = makeOps({
    retrieveSequence: [
      { intent: { status: "requiresConfirmation" } },
      "reject",
    ],
    confirmError: "timeout",
  });
  const result = await executeCardPayment(rejecting, "pi_secret");
  expect(result.kind).toBe("unknown-outcome");
  expect(canRetryCardPayment(result)).toBe(false);

  const errored = makeOps({
    retrieveSequence: [
      { intent: { status: "requiresConfirmation" } },
      { error: "could not retrieve" },
    ],
    confirmError: "timeout",
  });
  const second = await executeCardPayment(errored, "pi_secret");
  expect(second.kind).toBe("unknown-outcome");
  expect(canRetryCardPayment(second)).toBe(false);
});

it("fails safely (retry allowed) when the initial retrieve fails", async () => {
  const result = await executeCardPayment(
    makeOps({ retrieveSequence: [{ error: "no such payment" }] }),
    "pi_secret"
  );
  expect(result.kind).toBe("failed");
  expect(canRetryCardPayment(result)).toBe(true);
});

it("returns cancelled (retry allowed) when a seller cancel rejects the collect", async () => {
  // The Terminal SDK surfaces cancelCollectPaymentMethod as an ordinary
  // collect error; the cancel hook is what tells it apart from a decline.
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [{ intent: { status: "requiresPaymentMethod" } }],
      collectError: "The collect operation was canceled.",
    }),
    "pi_secret",
    undefined,
    { isCancelRequested: () => true }
  );
  expect(result.kind).toBe("cancelled");
  expect(canRetryCardPayment(result)).toBe(true);
});

it("still treats a collect error as a decline when no cancel was requested", async () => {
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [{ intent: { status: "requiresPaymentMethod" } }],
      collectError: "The card was declined.",
    }),
    "pi_secret",
    undefined,
    { isCancelRequested: () => false }
  );
  expect(result.kind).toBe("not-approved");
});

it("never cancels during processing: a cancel requested after the tap still confirms", async () => {
  // The buyer's card was already read; the cancel hook must not stop the
  // confirm or turn a later confirm failure into a retryable cancel.
  let cancelRequested = false;
  const ops = makeOps({
    retrieveSequence: [{ intent: { status: "requiresConfirmation" } }],
  });
  const result = await executeCardPayment(
    ops,
    "pi_secret",
    (phase) => {
      if (phase === "processing") cancelRequested = true;
    },
    { isCancelRequested: () => cancelRequested }
  );
  expect(result).toEqual({ kind: "approved" });
  expect(ops.confirmPaymentIntent).toHaveBeenCalledTimes(1);
});

it("reports unknown-outcome (no retry) when confirm fails after a late cancel request", async () => {
  let cancelRequested = false;
  const result = await executeCardPayment(
    makeOps({
      retrieveSequence: [
        { intent: { status: "requiresConfirmation" } },
        { intent: { status: "processing" } },
      ],
      confirmError: "timeout",
    }),
    "pi_secret",
    (phase) => {
      if (phase === "processing") cancelRequested = true;
    },
    { isCancelRequested: () => cancelRequested }
  );
  expect(result.kind).toBe("unknown-outcome");
  expect(canRetryCardPayment(result)).toBe(false);
});
