------------------- MODULE SellerOrder -------------------
EXTENDS TLC

Statuses == {"pending", "confirmed", "shipped", "completed", "canceled"}

VARIABLES status, previous, actor
vars == <<status, previous, actor>>

Init ==
  /\ status = "pending"
  /\ previous = "pending"
  /\ actor = "none"

SellerConfirms ==
  /\ status = "pending"
  /\ status' = "confirmed"
  /\ previous' = status
  /\ actor' = "seller"

SellerShips ==
  /\ status = "confirmed"
  /\ status' = "shipped"
  /\ previous' = status
  /\ actor' = "seller"

SellerCompletes ==
  /\ status = "shipped"
  /\ status' = "completed"
  /\ previous' = status
  /\ actor' = "seller"

BuyerCancels ==
  /\ status \in {"pending", "confirmed"}
  /\ status' = "canceled"
  /\ previous' = status
  /\ actor' = "buyer"

Next ==
  \/ SellerConfirms
  \/ SellerShips
  \/ SellerCompletes
  \/ BuyerCancels

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in Statuses
  /\ previous \in Statuses
  /\ actor \in {"none", "seller", "buyer"}

SellerAdvances ==
  status \in {"confirmed", "shipped", "completed"} => actor = "seller"

BuyerCancelsOnlyBeforeShipping ==
  status = "canceled" =>
    /\ actor = "buyer"
    /\ previous \in {"pending", "confirmed"}

===========================================================
