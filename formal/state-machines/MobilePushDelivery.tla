---------------- MODULE MobilePushDelivery ----------------
EXTENDS Naturals, TLC

Workers == {"workerA", "workerB"}
Statuses == {"queued", "sending", "accepted", "provider_accepted",
             "retry_wait", "invalid_device", "failed", "expired",
             "superseded"}
Tokens == 0..2
Attempts == 0..2

VARIABLES status, owner, token, generation, attempts, deviceEnabled
vars == <<status, owner, token, generation, attempts, deviceEnabled>>

Init ==
  /\ status = "queued"
  /\ owner = "none"
  /\ token = 0
  /\ generation = 0
  /\ attempts = 0
  /\ deviceEnabled = TRUE

Claim(w) ==
  /\ w \in Workers
  /\ deviceEnabled
  /\ generation < 2
  /\ attempts < 2
  /\ status \in {"queued", "retry_wait", "sending"}
  /\ status' = "sending"
  /\ owner' = w
  /\ generation' = generation + 1
  /\ token' = generation + 1
  /\ attempts' = attempts + 1
  /\ UNCHANGED deviceEnabled

ProviderAccept(expectedToken) ==
  /\ expectedToken \in Tokens
  /\ status = "sending"
  /\ owner \in Workers
  /\ token = expectedToken
  /\ status' = "accepted"
  /\ owner' = "none"
  /\ UNCHANGED <<token, generation, attempts, deviceEnabled>>

RetryableFailure(expectedToken) ==
  /\ expectedToken \in Tokens
  /\ status = "sending"
  /\ owner \in Workers
  /\ token = expectedToken
  /\ status' = "retry_wait"
  /\ owner' = "none"
  /\ UNCHANGED <<token, generation, attempts, deviceEnabled>>

PermanentFailure(expectedToken) ==
  /\ expectedToken \in Tokens
  /\ status = "sending"
  /\ owner \in Workers
  /\ token = expectedToken
  /\ status' = "failed"
  /\ owner' = "none"
  /\ UNCHANGED <<token, generation, attempts, deviceEnabled>>

DeviceInvalid(expectedToken) ==
  /\ expectedToken \in Tokens
  /\ status = "sending"
  /\ owner \in Workers
  /\ token = expectedToken
  /\ status' = "invalid_device"
  /\ owner' = "none"
  /\ deviceEnabled' = FALSE
  /\ UNCHANGED <<token, generation, attempts>>

ReceiptAccepted ==
  /\ status = "accepted"
  /\ status' = "provider_accepted"
  /\ UNCHANGED <<owner, token, generation, attempts, deviceEnabled>>

ReceiptRetryableError ==
  /\ status = "accepted"
  /\ status' = "retry_wait"
  /\ UNCHANGED <<owner, token, generation, attempts, deviceEnabled>>

ReceiptExpires ==
  /\ status = "accepted"
  /\ status' = "expired"
  /\ UNCHANGED <<owner, token, generation, attempts, deviceEnabled>>

Supersede ==
  /\ status \in {"queued", "retry_wait", "sending", "accepted"}
  /\ status' = "superseded"
  /\ owner' = "none"
  /\ UNCHANGED <<token, generation, attempts, deviceEnabled>>

Next ==
  \/ \E w \in Workers: Claim(w)
  \/ \E t \in Tokens: ProviderAccept(t)
  \/ \E t \in Tokens: RetryableFailure(t)
  \/ \E t \in Tokens: PermanentFailure(t)
  \/ \E t \in Tokens: DeviceInvalid(t)
  \/ ReceiptAccepted
  \/ ReceiptRetryableError
  \/ ReceiptExpires
  \/ Supersede

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in Statuses
  /\ owner \in (Workers \cup {"none"})
  /\ token \in Tokens
  /\ generation \in Tokens
  /\ attempts \in Attempts
  /\ deviceEnabled \in BOOLEAN

SendingHasLease ==
  (status = "sending") <=> (owner \in Workers)

DeviceInvalidDisablesDevice ==
  status = "invalid_device" => ~deviceEnabled

TerminalDeliveryHasNoLease ==
  status \in {"provider_accepted", "failed", "expired", "superseded",
              "invalid_device"} => owner = "none"

============================================================
