---
name: One-shot idempotency claim ordering
description: Where to take a once-per-key "claim" relative to skip/empty early-returns so a no-op attempt can't permanently burn it.
---

A one-shot idempotency claim (a ledger row that makes an action runnable exactly once per key — e.g. once per published version) must be taken AFTER every skip condition and early-return, INCLUDING the "nobody to act on" / empty-result case — never before.

**Why:** the blog email-broadcast endpoint originally claimed `(pubkey,dTag,eventId)` before resolving the recipient audience. A publish with zero subscribers returned `empty-audience` but kept the ledger row, so once the seller actually had subscribers the same version returned `already-sent` and could never be broadcast. A claim is a promise that real work happened; a no-op must not consume it.

**How to apply:** order the handler as validate → auth → gates (Pro / verified-sender / unsubscribe-secret) → resolve the real work set → if empty, return WITHOUT claiming → claim → do the work → release the claim on total failure. Concurrency stays safe because only the winning claim proceeds to act; a racing caller gets `already-sent`. Applies to any new broadcast / once-per-thing feature, e.g. scheduled blog publishing that reuses this path.
