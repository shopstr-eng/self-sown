/**
 * A Stripe Terminal confirmPaymentIntent ERROR does not prove the customer
 * was not charged: the SDK can fail to return a result after the payment was
 * captured (network drop mid-confirm). Before showing a "no charge" receipt
 * or offering "Try again" (which would double-charge), the card screen
 * re-retrieves the PaymentIntent and classifies its authoritative status.
 */
export type CardConfirmOutcome = "approved" | "not-approved" | "unknown";

export function classifyConfirmFailure(
  status: string | undefined
): CardConfirmOutcome {
  if (status === "succeeded" || status === "requiresCapture") {
    return "approved";
  }
  if (status === "canceled" || status === "requiresPaymentMethod") {
    return "not-approved";
  }
  // processing / requiresConfirmation / requiresAction / retrieve failure:
  // the outcome is not knowable here — the seller must check Stripe before
  // retrying, so no decline receipt and no "not approved" notification.
  return "unknown";
}
