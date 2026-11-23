---------------- MODULE CashuEscrowOutbox ----------------
EXTENDS Naturals, TLC

\* TRUE models the safe protocol assumption. FALSE models today's conversion
\* SQL, which does not observe the mint before discarding prepared outputs.
CONSTANT ProtectSpentConversion
ASSUME ProtectSpentConversion \in BOOLEAN

Workers == {"workerA", "workerB"}
RegistrationStates == {"locked", "released", "refunded"}
OutboxStates == {"absent", "pending", "processing", "done"}
Actions == {"none", "release", "refund"}
Stages == {"none", "awaiting_witness", "ready", "executing", "needs_refund_payload"}
LockWindows == {"open", "expired"}
ClaimTokens == 0..2
MintStates == {"unspent", "spent"}

VARIABLES registration, outbox, action, stage, lockWindow,
          owner, token, generation, prepared, mint, outputsSaved, releaseSwapWindow
vars == <<registration, outbox, action, stage, lockWindow, owner, token,
          generation, prepared, mint, outputsSaved, releaseSwapWindow>>

Init ==
  /\ registration = "locked"
  /\ outbox = "absent"
  /\ action = "none"
  /\ stage = "none"
  /\ lockWindow = "open"
  /\ owner = "none"
  /\ token = 0
  /\ generation = 0
  /\ prepared = FALSE
  /\ mint = "unspent"
  /\ outputsSaved = FALSE
  /\ releaseSwapWindow = "none"

EnqueueRelease ==
  /\ registration = "locked"
  /\ outbox = "absent"
  /\ action = "none"
  /\ lockWindow = "open"
  /\ outbox' = "pending"
  /\ action' = "release"
  /\ stage' = "awaiting_witness"
  /\ UNCHANGED <<registration, lockWindow, owner, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

SellerProvidesWitness ==
  /\ action = "release"
  /\ outbox = "pending"
  /\ stage = "awaiting_witness"
  /\ stage' = "ready"
  /\ UNCHANGED <<registration, outbox, action, lockWindow, owner, token,
                 generation, prepared, mint, outputsSaved, releaseSwapWindow>>

EnqueueRefund ==
  /\ registration = "locked"
  /\ outbox = "absent"
  /\ action = "none"
  /\ outbox' = "pending"
  /\ action' = "refund"
  /\ stage' = "ready"
  /\ UNCHANGED <<registration, lockWindow, owner, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

ExpireLock ==
  /\ lockWindow = "open"
  /\ lockWindow' = "expired"
  /\ UNCHANGED <<registration, outbox, action, stage, owner, token,
                 generation, prepared, mint, outputsSaved, releaseSwapWindow>>

AutoEnqueueRefund ==
  /\ registration = "locked"
  /\ lockWindow = "expired"
  /\ outbox = "absent"
  /\ action = "none"
  /\ outbox' = "pending"
  /\ action' = "refund"
  /\ stage' = "needs_refund_payload"
  /\ UNCHANGED <<registration, lockWindow, owner, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

AttachRefundPayload ==
  /\ registration = "locked"
  /\ action = "refund"
  /\ outbox = "pending"
  /\ stage = "needs_refund_payload"
  /\ stage' = "ready"
  /\ UNCHANGED <<registration, outbox, action, lockWindow, owner, token,
                 generation, prepared, mint, outputsSaved, releaseSwapWindow>>

Claim(w) ==
  /\ w \in Workers
  /\ outbox = "pending"
  /\ stage = "ready"
  /\ generation < 2
  /\ outbox' = "processing"
  /\ owner' = w
  /\ generation' = generation + 1
  /\ token' = generation + 1
  /\ UNCHANGED <<registration, action, stage, lockWindow,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

ValidateAttempt ==
  /\ outbox = "processing"
  /\ stage = "ready"
  /\ (action = "refund" \/ lockWindow = "open")
  /\ stage' = "executing"
  /\ UNCHANGED <<registration, outbox, action, lockWindow, owner, token,
                 generation, prepared, mint, outputsSaved, releaseSwapWindow>>

SavePreparedOutputs ==
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ stage = "executing"
  /\ ~prepared
  /\ prepared' = TRUE
  /\ UNCHANGED <<registration, outbox, action, stage, lockWindow, owner,
                 token, generation, mint, outputsSaved, releaseSwapWindow>>

MintSwap ==
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ stage = "executing"
  /\ prepared
  /\ mint = "unspent"
  /\ (action = "refund" \/ lockWindow = "open")
  /\ mint' = "spent"
  /\ outputsSaved' = FALSE
  /\ releaseSwapWindow' =
       IF action = "release" THEN lockWindow ELSE releaseSwapWindow
  /\ UNCHANGED <<registration, outbox, action, stage, lockWindow, owner,
                 token, generation, prepared>>

RecoverPreparedOutputs ==
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ stage = "executing"
  /\ prepared
  /\ mint = "spent"
  /\ ~outputsSaved
  /\ outputsSaved' = TRUE
  /\ UNCHANGED <<registration, outbox, action, stage, lockWindow, owner,
                 token, generation, prepared, mint, releaseSwapWindow>>

Finalize(expectedToken) ==
  /\ expectedToken \in ClaimTokens
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ token = expectedToken
  /\ mint = "spent"
  /\ outputsSaved
  /\ outbox' = "done"
  /\ registration' = IF action = "release" THEN "released" ELSE "refunded"
  /\ owner' = "none"
  /\ UNCHANGED <<action, stage, lockWindow, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

ReleaseFailedAttempt ==
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ outbox' = "pending"
  /\ owner' = "none"
  /\ stage' = "ready"
  /\ UNCHANGED <<registration, action, lockWindow, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

RecoverStaleClaim ==
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ outbox' = "pending"
  /\ owner' = "none"
  /\ stage' = "ready"
  /\ UNCHANGED <<registration, action, lockWindow, token, generation,
                 prepared, mint, outputsSaved, releaseSwapWindow>>

ConvertExpiredRelease ==
  /\ registration = "locked"
  /\ action = "release"
  /\ outbox = "processing"
  /\ owner \in Workers
  /\ stage = "ready"
  /\ lockWindow = "expired"
  /\ (ProtectSpentConversion => mint = "unspent")
  /\ outbox' = "pending"
  /\ action' = "refund"
  /\ stage' = "needs_refund_payload"
  /\ owner' = "none"
  /\ prepared' = FALSE
  /\ outputsSaved' = FALSE
  /\ UNCHANGED <<registration, lockWindow, token, generation, mint, releaseSwapWindow>>

Next ==
  \/ EnqueueRelease
  \/ SellerProvidesWitness
  \/ EnqueueRefund
  \/ ExpireLock
  \/ AutoEnqueueRefund
  \/ AttachRefundPayload
  \/ \E w \in Workers: Claim(w)
  \/ ValidateAttempt
  \/ SavePreparedOutputs
  \/ MintSwap
  \/ RecoverPreparedOutputs
  \/ \E t \in ClaimTokens: Finalize(t)
  \/ ReleaseFailedAttempt
  \/ RecoverStaleClaim
  \/ ConvertExpiredRelease

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ registration \in RegistrationStates
  /\ outbox \in OutboxStates
  /\ action \in Actions
  /\ stage \in Stages
  /\ lockWindow \in LockWindows
  /\ owner \in (Workers \cup {"none"})
  /\ token \in ClaimTokens
  /\ generation \in ClaimTokens
  /\ prepared \in BOOLEAN
  /\ mint \in MintStates
  /\ outputsSaved \in BOOLEAN
  /\ releaseSwapWindow \in (LockWindows \cup {"none"})

ResolutionMatchesOutbox ==
  registration \in {"released", "refunded"} =>
    /\ outbox = "done"
    /\ action = (IF registration = "released" THEN "release" ELSE "refund")

ClaimHasLiveLease ==
  (outbox = "processing") <=> (owner \in Workers)

NoUnwitnessedReleaseClaim ==
  stage = "awaiting_witness" => outbox # "processing"

PreparedBeforeMint ==
  mint = "spent" => prepared

NoReleasePayoutAfterExpiry ==
  registration = "released" => releaseSwapWindow = "open"

FinalizedOutputsRecorded ==
  outbox = "done" => outputsSaved

===========================================================
