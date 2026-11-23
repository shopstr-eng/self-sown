-------------------- MODULE UcpCheckout --------------------
EXTENDS Naturals, TLC

CheckoutStatuses ==
  {"incomplete", "ready_for_complete", "complete_in_progress",
   "completed", "requires_escalation", "canceled"}
PaymentStatuses == {"pending", "processing", "paid", "failed", "refunded"}
RetryStates == {"none", "claimed", "settled", "blocked"}

VARIABLES checkout, payment, orderMayExist, retry
vars == <<checkout, payment, orderMayExist, retry>>

Init ==
  /\ checkout = "incomplete"
  /\ payment = "pending"
  /\ orderMayExist = FALSE
  /\ retry = "none"

StartOrder ==
  /\ checkout = "incomplete"
  /\ ~orderMayExist
  /\ retry = "none"
  /\ checkout' = "ready_for_complete"
  /\ payment' = "pending"
  /\ orderMayExist' = TRUE
  /\ UNCHANGED retry

FailBeforeOrder ==
  /\ checkout = "incomplete"
  /\ ~orderMayExist
  /\ retry = "none"
  /\ checkout' = "requires_escalation"
  /\ orderMayExist' = FALSE
  /\ UNCHANGED <<payment, retry>>

CashuSettled ==
  /\ checkout = "incomplete"
  /\ ~orderMayExist
  /\ retry = "none"
  /\ checkout' = "completed"
  /\ payment' = "paid"
  /\ orderMayExist' = TRUE
  /\ UNCHANGED retry

RequestCompletion ==
  /\ checkout \in {"incomplete", "ready_for_complete", "requires_escalation"}
  /\ checkout' = "complete_in_progress"
  /\ UNCHANGED <<payment, orderMayExist, retry>>

PaymentProcessing ==
  /\ checkout \in {"ready_for_complete", "complete_in_progress"}
  /\ orderMayExist
  /\ checkout' = "complete_in_progress"
  /\ payment' = "processing"
  /\ UNCHANGED <<orderMayExist, retry>>

PaymentSucceeded ==
  /\ checkout \in {"incomplete", "ready_for_complete",
                   "complete_in_progress", "requires_escalation"}
  /\ orderMayExist
  /\ checkout' = "completed"
  /\ payment' = "paid"
  /\ UNCHANGED <<orderMayExist, retry>>

PaymentFailed ==
  /\ checkout \in {"incomplete", "ready_for_complete",
                   "complete_in_progress"}
  /\ orderMayExist
  /\ checkout' = "requires_escalation"
  /\ payment' = "failed"
  /\ UNCHANGED <<orderMayExist, retry>>

PaymentRefunded ==
  /\ checkout \in {"incomplete", "ready_for_complete",
                   "complete_in_progress", "requires_escalation"}
  /\ orderMayExist
  /\ checkout' = "canceled"
  /\ payment' = "refunded"
  /\ UNCHANGED <<orderMayExist, retry>>

ClaimPreOrderRetry ==
  /\ checkout = "requires_escalation"
  /\ ~orderMayExist
  /\ retry = "none"
  /\ checkout' = "incomplete"
  /\ retry' = "claimed"
  /\ UNCHANGED <<payment, orderMayExist>>

RetryFailedBeforeOrder ==
  /\ checkout = "incomplete"
  /\ retry = "claimed"
  /\ ~orderMayExist
  /\ checkout' = "requires_escalation"
  /\ retry' = "none"
  /\ UNCHANGED <<payment, orderMayExist>>

RetryPlacedOrder ==
  /\ checkout = "incomplete"
  /\ retry = "claimed"
  /\ ~orderMayExist
  /\ checkout' = "ready_for_complete"
  /\ orderMayExist' = TRUE
  /\ retry' = "settled"
  /\ payment' = "pending"

RetrySettledCashu ==
  /\ checkout = "incomplete"
  /\ retry = "claimed"
  /\ ~orderMayExist
  /\ checkout' = "completed"
  /\ orderMayExist' = TRUE
  /\ retry' = "settled"
  /\ payment' = "paid"

RetryOutcomeAmbiguous ==
  /\ checkout = "incomplete"
  /\ retry = "claimed"
  /\ checkout' = "incomplete"
  /\ orderMayExist' = TRUE
  /\ retry' = "blocked"
  /\ UNCHANGED payment

RetryResultAfterConcurrentCompletion ==
  /\ checkout = "complete_in_progress"
  /\ retry = "claimed"
  /\ ~orderMayExist
  /\ retry' = "blocked"
  /\ orderMayExist' = TRUE
  /\ UNCHANGED <<checkout, payment>>

Next ==
  \/ StartOrder
  \/ FailBeforeOrder
  \/ CashuSettled
  \/ RequestCompletion
  \/ PaymentProcessing
  \/ PaymentSucceeded
  \/ PaymentFailed
  \/ PaymentRefunded
  \/ ClaimPreOrderRetry
  \/ RetryFailedBeforeOrder
  \/ RetryPlacedOrder
  \/ RetrySettledCashu
  \/ RetryOutcomeAmbiguous
  \/ RetryResultAfterConcurrentCompletion

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ checkout \in CheckoutStatuses
  /\ payment \in PaymentStatuses
  /\ orderMayExist \in BOOLEAN
  /\ retry \in RetryStates

RetryClaimIsPreOrder ==
  retry = "claimed" => ~orderMayExist

AmbiguousRetryNeverReopens ==
  retry = "blocked" => orderMayExist

\* Diagnostic property: /complete can change a claimed retry's status before
\* resolveCheckoutSessionRetry's WHERE status='incomplete' settlement.
ClaimRemainsSettleable ==
  retry = "claimed" => checkout = "incomplete"

CompletedMeansPaid ==
  checkout = "completed" => payment = "paid"

CanceledMeansRefunded ==
  checkout = "canceled" => payment = "refunded"

=============================================================
