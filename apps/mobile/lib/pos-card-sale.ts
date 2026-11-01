import { classifyConfirmFailure } from "./pos-card-outcome";

/**
 * Testable core of the Tap to Pay card charge, split out of the screen so the
 * retry-safety rule is pinned by tests: a charge may only be RETRIED when
 * Stripe confirms no payment happened. A confirmPaymentIntent error is
 * ambiguous — the capture may have succeeded without the SDK returning a
 * result — so an unreadable or in-flight PaymentIntent yields
 * "unknown-outcome", for which the screen must block "Try again" or the
 * seller can double-charge the customer.
 */
export type CardPaymentResult =
  | { kind: "approved" }
  | { kind: "not-approved"; message: string }
  | { kind: "unknown-outcome"; message: string }
  /** Failure before the buyer's card was involved; retrying is safe. */
  | { kind: "failed"; message: string };

export function canRetryCardPayment(result: CardPaymentResult): boolean {
  return result.kind === "not-approved" || result.kind === "failed";
}

interface TerminalResult<T> {
  error?: { message: string };
  paymentIntent?: T;
}

export interface CardPaymentOps<TIntent> {
  retrievePaymentIntent: (
    clientSecret: string
  ) => Promise<TerminalResult<TIntent>>;
  collectPaymentMethod: (args: {
    paymentIntent: TIntent;
  }) => Promise<TerminalResult<TIntent>>;
  confirmPaymentIntent: (args: {
    paymentIntent: TIntent;
  }) => Promise<TerminalResult<TIntent>>;
  /** Stripe Terminal PaymentIntent status, e.g. "succeeded", "canceled". */
  statusOf: (intent: TIntent) => string | undefined;
}

const UNKNOWN_OUTCOME_MESSAGE =
  "The reader didn't confirm the result. Check your Stripe Dashboard for this payment before retrying, so the customer isn't charged twice.";

export async function executeCardPayment<TIntent>(
  ops: CardPaymentOps<TIntent>,
  clientSecret: string,
  onPhase?: (phase: "ready" | "processing") => void
): Promise<CardPaymentResult> {
  const retrieved = await ops.retrievePaymentIntent(clientSecret);
  if (retrieved.error || !retrieved.paymentIntent) {
    return {
      kind: "failed",
      message: retrieved.error?.message ?? "Could not load the card payment.",
    };
  }

  onPhase?.("ready");
  const collected = await ops.collectPaymentMethod({
    paymentIntent: retrieved.paymentIntent,
  });
  if (collected.error || !collected.paymentIntent) {
    // Collection only reads the card — a failure here cannot have charged it.
    return {
      kind: "not-approved",
      message: collected.error?.message ?? "The card was declined.",
    };
  }

  onPhase?.("processing");
  const confirmed = await ops.confirmPaymentIntent({
    paymentIntent: collected.paymentIntent,
  });
  if (!confirmed.error && confirmed.paymentIntent) return { kind: "approved" };

  // Reconcile against Stripe's authoritative status before calling it a
  // decline: a confirm error can mask a captured payment.
  const recheck = await ops
    .retrievePaymentIntent(clientSecret)
    .catch(() => null);
  const outcome = classifyConfirmFailure(
    recheck?.paymentIntent ? ops.statusOf(recheck.paymentIntent) : undefined
  );
  if (outcome === "approved") return { kind: "approved" };
  if (outcome === "not-approved") {
    return {
      kind: "not-approved",
      message: confirmed.error?.message ?? "The card was declined.",
    };
  }
  return { kind: "unknown-outcome", message: UNKNOWN_OUTCOME_MESSAGE };
}
