----------------------------- MODULE OAuthHandoff -----------------------------
EXTENDS Naturals, FiniteSets

\* Bounded two-client abstraction of the atomic DELETE RETURNING exchange and
\* local ciphertext replacement. Crypto, HTTPS and secure cookie enforcement
\* are implementation contracts checked separately, not proved by this model.
VARIABLES ticket, expired, holders, saved, legacyPresent, navigating
vars == <<ticket, expired, holders, saved, legacyPresent, navigating>>
Clients == {1, 2}

Init ==
  /\ ticket = "issued"
  /\ expired = FALSE
  /\ holders = {}
  /\ saved = {}
  /\ legacyPresent = Clients
  /\ navigating = {}

Consume(c) ==
  /\ ticket = "issued" /\ ~expired
  /\ ticket' = "consumed"
  /\ holders' = holders \cup {c}
  /\ UNCHANGED <<expired, saved, legacyPresent, navigating>>

Expire ==
  /\ ~expired
  /\ expired' = TRUE
  /\ UNCHANGED <<ticket, holders, saved, legacyPresent, navigating>>

SaveEncryptedReplacement(c) ==
  /\ c \in holders /\ c \notin saved
  /\ saved' = saved \cup {c}
  /\ legacyPresent' = legacyPresent \ {c}
  /\ UNCHANGED <<ticket, expired, holders, navigating>>

SaveFailure(c) ==
  /\ c \in holders /\ c \notin saved
  /\ UNCHANGED vars

Navigate(c) ==
  /\ c \in saved /\ c \notin navigating
  /\ navigating' = navigating \cup {c}
  /\ UNCHANGED <<ticket, expired, holders, saved, legacyPresent>>

Next == Expire \/ \E c \in Clients:
  Consume(c) \/ SaveEncryptedReplacement(c) \/ SaveFailure(c) \/ Navigate(c)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ ticket \in {"issued", "consumed"} /\ expired \in BOOLEAN
  /\ holders \subseteq Clients /\ saved \subseteq Clients
  /\ legacyPresent \subseteq Clients /\ navigating \subseteq Clients
SingleConsumer == Cardinality(holders) <= 1
OnlyReceivedKeysSaved == saved \subseteq holders
NoNavigationBeforeSave == navigating \subseteq saved
NoLegacyLossBeforeSave == Clients \ saved \subseteq legacyPresent
=============================================================================
