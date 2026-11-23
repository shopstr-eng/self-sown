------------------ MODULE ProMembership ------------------
EXTENDS TLC

Statuses == {"free", "trialing", "active", "grace", "readonly", "hidden"}

VARIABLES status, lifetime
vars == <<status, lifetime>>

Init ==
  /\ status = "free"
  /\ lifetime = FALSE

BeginTrial ==
  /\ status = "free"
  /\ status' = "trialing"
  /\ UNCHANGED lifetime

PaidTermBegins ==
  /\ status \in {"free", "trialing", "active", "grace", "readonly", "hidden"}
  /\ status' = "active"
  /\ UNCHANGED lifetime

PeriodExpires ==
  /\ status \in {"trialing", "active"}
  /\ ~lifetime
  /\ status' = "grace"
  /\ UNCHANGED lifetime

GraceExpires ==
  /\ status = "grace"
  /\ ~lifetime
  /\ status' = "readonly"
  /\ UNCHANGED lifetime

ReadOnlyPeriodExpires ==
  /\ status = "readonly"
  /\ ~lifetime
  /\ status' = "hidden"
  /\ UNCHANGED lifetime

GrantLifetime ==
  /\ status \in {"free", "trialing", "active", "grace", "readonly", "hidden"}
  /\ status' = "active"
  /\ lifetime' = TRUE

Next ==
  \/ BeginTrial
  \/ PaidTermBegins
  \/ PeriodExpires
  \/ GraceExpires
  \/ ReadOnlyPeriodExpires
  \/ GrantLifetime

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in Statuses
  /\ lifetime \in BOOLEAN

LifetimeIsActive ==
  lifetime => status = "active"

EntitlementWindow ==
  status \in {"trialing", "active", "grace"}

===========================================================
