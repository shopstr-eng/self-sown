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

Payout worker rules (fund-moving outbox + external mint calls):

3. **Two-phase swap, persist before paying.** Prepare the swap, durably store the serialized payee-locked output data (fenced by the claim token), and only then submit to the mint. A retry that finds inputs SPENT reconstructs the payee's proofs from the persisted blinded messages via the mint's NUT-09 /restore endpoint; SPENT-with-nothing-persisted is operator reconciliation and must still never re-pay.
   **Why:** the window between mint-accept and the finalize DB write otherwise burns the payout — payee-locked P2PK outputs are useless without their secrets, which lived only in process memory.
   **How to apply:** any fund-moving flow whose result exists only in memory between an external accept and a local write needs the prepared material durably stored first, plus a restore/reconciliation path on retry.

4. **Proof-state checks must be strict and run before EVERY attempt.** Require exactly one state per input, every state explicitly UNSPENT to pay, and EVERY input SPENT before entering crash-recovery — a mixed state set (some SPENT, some not) is inconsistent/in-flight and must neither pay nor restore. Never treat "not SPENT" as "safe".
   **Why:** outbox fencing can't make an external mint call exactly-once; lenient state checks let a degraded mint response slip a double-pay or a premature restore-and-finalize through.

5. **Allowlist P2PK lock tags — never just check the ones you use.** A `pubkeys` tag silently widens a seller-only lock to 1-of-2 with an attacker's key even with `n_sigs` absent/1; unknown NUT-11 tags carry mint semantics you never reviewed.
   **How to apply:** validate the exact construction (data, locktime, refund, no multisig, SIG_INPUTS only) AND reject any tag outside the allowlist.

6. **One-row-per-escrow needs an expiry escape hatch.** A release claimed before expiry but executed after it can't pay (expiry re-check) — and would otherwise block the buyer's refund forever, since the refund enqueue is rejected by the same row. Convert release→refund atomically, fenced by the claim token and conditional on actual expiry.
7. **Failed fund-moving entries need exponential backoff in the listing query** (1min→6h cap; fresh entries due immediately) or a permanently-failing row hot-loops the external service every sweep. The backoff keys off the row's `updated_at`, so attaching a payout payload re-arms it (a buyer attaching proofs after several payload-less auto-attempts waits out the current backoff before the drain). That's expected — don't "fix" it without re-checking the hot-loop guard.
8. **The worker revalidates every payload — endpoint-only validation context must travel inside the server-attached payload.** An endpoint that validates under non-default options (e.g. `directedByArbiter`) but stores only `{proofs, stage}` gets its authorized payout silently rejected at payout time, because the executor revalidates under default rules.
   **Why:** the worker never trusts the endpoint's judgment; anything not persisted server-side is lost at the handoff. Endpoint tests mock the validator, so only an executor-level test exercises the rejection.
   **How to apply:** persist any non-default validation mode as a server-set field on the outbox payload (never client-supplied), thread it into the executor's revalidation, and test at the executor level, not only at the endpoint.
9. **The executor's expiry gate must validate with fresh time — it is the ONLY locktime enforcement.** Production callers never pass nowSeconds into executeEscrowPayout/validateEscrowPayoutProofs (injectable for unit tests only), and the executor re-checks expiry immediately before the mint call. Do not assume mints enforce NUT-11 locktime: Nutshell (observed 0.20.x, FakeWallet) accepts P2PK data-key spends after locktime.
   **Why:** a caller-pinned clock lets a release claimed pre-expiry validate against stale time and pay the seller post-expiry; unit tests inject nowSeconds, so they can never catch the drift.
   **How to apply:** new payout callers omit nowSeconds; new mints get a locktime-enforcement probe before joining the escrow allowlist.
