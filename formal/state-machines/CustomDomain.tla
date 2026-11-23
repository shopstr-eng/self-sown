------------------ MODULE CustomDomain ------------------
EXTENDS TLC

Statuses == {"pending_dns", "dns_verified", "attached", "active", "failed"}

VARIABLES status, verified
vars == <<status, verified>>

Init ==
  /\ status = "pending_dns"
  /\ verified = FALSE

DnsOwnershipVerified ==
  /\ status = "pending_dns"
  /\ status' = "dns_verified"
  /\ verified' = TRUE

DeploymentAttached ==
  /\ status = "dns_verified"
  /\ verified
  /\ status' = "attached"
  /\ verified' = verified

TlsReady ==
  /\ status \in {"dns_verified", "attached"}
  /\ verified
  /\ status' = "active"
  /\ verified' = verified

Next == DnsOwnershipVerified \/ DeploymentAttached \/ TlsReady

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in Statuses
  /\ verified \in BOOLEAN

ActiveIsVerified ==
  status = "active" => verified

===========================================================
