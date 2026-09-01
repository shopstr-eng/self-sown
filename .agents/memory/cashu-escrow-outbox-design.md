---
name: Cashu escrow outbox design rules
description: Money-moving outbox rows must be one-per-escrow with claim fencing tokens and conditional terminal transitions; commitment events need exactly-once tags + canonical content
---

Two design rules from the Cashu escrow prerequisites (utils/db/cashu-escrow-service.ts, utils/cashu/escrow-commitment.ts), both caught by architect review after the first pass missed them:

1. **Payout outbox: one row per escrow, fenced claims.** The outbox id IS the escrow id (plus a UNIQUE constraint) so a release and a refund can never both become payable. Each claim mints a fresh claim_token; finalize/release require it, and finalize also requires the registration to still be 'locked'. A stale worker whose claim was reclaimed is fenced out of completing the payout.
   **Why:** a first version allowed separate release+refund rows and token-less claims — two workers could both pay out, and a crashed worker could clobber a reclaimer. Durable outbox alone still cannot make an external mint call exactly-once; the payout worker must verify mint proof state before any retry.
   **How to apply:** any future outbox/claim table that moves funds gets the same treatment (single row per subject, fencing token, conditional terminal UPDATE with rowCount check).

2. **Signed commitment events: exactly-once tags + byte-exact canonical content.** Every signed tag must appear exactly once with exactly one value, and event content must be the canonical JSON re-derivation of the tags.
   **Why:** `tags.find()` accepts duplicates, so a validly-signed event could carry two divergent seller/amount tags read differently by different components; tag/content disagreement is the same hole.
   **How to apply:** any new "server trusts a client-signed Nostr event" endpoint should reject duplicate/malformed tags and recompute content rather than parse it as truth.
