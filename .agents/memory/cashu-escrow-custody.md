---
name: Cashu escrow custody rule
description: Escrow-locked proofs stay with the buyer until a signed payout; payment messages reference the escrow id, never the token
---

In Cashu escrow, the P2PK-locked proofs (primary key = seller, refund key = buyer after locktime) are NEVER sent to the seller at checkout: the seller's key can redeem an ACTIVE lock immediately, so delivering the token is a pre-expiry handover, not escrow. The buyer keeps custody client-side — the record write is fail-closed at checkout and records are never truncated, since each is the only custody material for a possibly-unresolved escrow (prune only after resolution). Payment messages/receipts reference the escrow by id under a non-token payment type; the orders/chat UI only treats the plain ecash type as spendable. Funds move only through the signed payout flow: the entitled party (seller pre-expiry, buyer post-expiry) witnesses the proofs and attaches them to the one-row outbox, which a keyless worker pays out.

**Why:** a single checkout branch that ships the token breaks escrow for that path, and any payout entry the entitled party cannot complete strands funds permanently — every pending stage needs an owner who can advance it at every point in the lock's lifetime, including after expiry.

**How to apply:** new checkout message/receipt branches must go through the escrow conditional (pinned by the escrow-custody source-invariant test). New payout legs follow the signed-attach pattern: never report success before the attach lands, surface enough status for the entitled party to complete or retry, and any seller-owned pending stage that can outlive the lock must convert to the buyer's refund at expiry.
