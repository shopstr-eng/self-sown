---
name: Shipment label purchase dedup race
description: Why the buy-label duplicate guard must be a single synchronous claim, not check-then-mark.
---

# Shipment label purchase: atomic claim, not check-then-mark

The in-memory `purchasedShipments` Set dedups label purchases per `shipmentId`.
The guard MUST be a single synchronous claim (`claimShipmentForPurchase`) taken
BEFORE any `await`, with a release on failure — never `isAlreadyPurchased()` →
`await ...` → `markPurchased()`.

**Why:** With a check-then-mark split by an `await` (e.g. token lookup +
`buyLabel`), two concurrent requests for the same shipment both pass the check
before either marks, producing duplicate Shippo charges/labels. The original
single-platform code masked this because a per-pubkey Postgres advisory spend
lock (`withPubkeySpendLock`) incidentally serialized concurrent buys. The OAuth
gray-label migration removed that lock (no platform spend cap anymore), which
re-exposed the latent TOCTOU race.

**How to apply:** Any time you remove a lock that was incidentally serializing a
check-and-mark, collapse the check+mark into one synchronous claim before the
first await; release it on any pre-success throw so the caller can retry. This
guard is single-instance (in-memory); a multi-instance deployment would need a
DB-backed idempotency key instead.
