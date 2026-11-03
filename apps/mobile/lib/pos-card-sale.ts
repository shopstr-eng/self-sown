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
  /**
   * The seller aborted the wait for the buyer's tap. The card was never
   * read, so retrying is safe and no decline receipt/notification applies.
   */
  | { kind: "cancelled"; message: string }
  /** Failure before the buyer's card was involved; retrying is safe. */
  | { kind: "failed"; message: string };

export function canRetryCardPayment(result: CardPaymentResult): boolean {
  return (
    result.kind === "not-approved" ||
    result.kind === "cancelled" ||
    result.kind === "failed"
  );
}

/**
 * Seller-cancel hook for the "waiting for tap" window. The Terminal SDK's
 * cancelCollectPaymentMethod rejects the in-flight collect, which arrives
 * here as an ordinary collect error — indistinguishable from a decline
 * without this hook. It is only consulted on the collect path, never after
 * confirm starts: cancelling an in-flight confirm could leave the buyer
 * charged with the sale unrecorded.
 */
export interface CardPaymentCancel {
  isCancelRequested: () => boolean;
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
  onPhase?: (phase: "ready" | "processing") => void,
  cancel?: CardPaymentCancel
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
    // A seller-requested cancel surfaces as a collect error too. It must NOT
    // be treated as a decline (no receipt, no notification — the card was
    // never read). The abandoned PaymentIntent is left in
    // requiresPaymentMethod with no payment method attached, so nothing can
    // confirm or charge it later: safe to leave behind.
    if (cancel?.isCancelRequested()) {
      return {
        kind: "cancelled",
        message: "Payment cancelled. Nothing was charged.",
      };
    }
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
