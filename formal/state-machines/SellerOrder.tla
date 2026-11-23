------------------- MODULE SellerOrder -------------------
EXTENDS TLC

Statuses == {"pending", "confirmed", "shipped", "completed", "canceled"}

VARIABLE status
vars == <<status>>

Init == status = "pending"

SellerConfirms ==
  /\ status = "pending"
  /\ status' = "confirmed"

SellerShips ==
  /\ status = "confirmed"
  /\ status' = "shipped"

SellerCompletes ==
  /\ status = "shipped"
  /\ status' = "completed"

BuyerCancels ==
  /\ status \in {"pending", "confirmed"}
  /\ status' = "canceled"

Next ==
  \/ SellerConfirms
  \/ SellerShips
  \/ SellerCompletes
  \/ BuyerCancels

Spec == Init /\ [][Next]_vars

TypeOK == status \in Statuses

===========================================================
