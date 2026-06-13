---
name: Shipping shipment claim + dedup
description: How shipment ownership and the duplicate-purchase guard work, and the rules for keeping them race-safe.
---

# Shipping: cross-instance shipment ownership + duplicate-purchase guard

Shipment ownership (which seller may buy a quoted label) AND the
duplicate-purchase guard both live in one Postgres table
(`shipping_shipment_claims`), keyed by `shipment_id`, with a `status` of
`'owned'` → `'purchased'`. The claim is an atomic
`INSERT ... ON CONFLICT (shipment_id) DO UPDATE ... WHERE status='owned'
RETURNING` — exactly one concurrent caller gets a returned row (the winner);
losers get 0 rows and a 409.

**Why:** Earlier this was in-memory (a Map + a Set). A check-then-mark split by
an `await` produced a TOCTOU double-buy; the original single-platform code
masked it with a per-pubkey Postgres advisory spend lock that incidentally
serialized buys. The OAuth gray-label migration removed that lock, so the guard
had to become a DB-backed atomic claim that also holds across multiple server
instances (in-memory state is per-process and breaks when scaled out).

**How to apply:**

- The winner of a claim MUST `releaseShipmentClaim` (reverts `purchased`→`owned`)
  on any pre-success failure, or the seller can never retry that shipment.
- `getShipmentOwner` must stay status-agnostic within the TTL so a duplicate buy
  after success resolves to 409 (claim lost) rather than 403 (looks un-quoted).
- Return labels have no client shipmentId (a fresh Shippo shipment each call),
  so dedup uses a deterministic idempotency key. That key MUST be built from a
  CANONICAL serialization (recursively sorted object keys, trimmed/lowercased
  strings, sorted order-insensitive arrays like carriers) over ALL
  cost-defining fields (from, to, parcel, carriers, serviceToken,
  insuranceAmount). Plain `JSON.stringify` is NOT canonical — key-order/casing
  drift between clients hashes differently and lets duplicates through.
- The table is transient; prune stale rows (owned ~1h, purchased ~7d). The
  permanent label record is `shipping_labels`. Keep prune thresholds far longer
  than any in-flight purchase window so cleanup can never delete a live claim.
