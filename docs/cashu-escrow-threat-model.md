# Cashu P2PK Escrow — Threat Model & Safety Gates

Status: **prerequisites built, feature disabled by default.** The existing
direct Cashu checkout (buyer sends an ecash token straight to the seller via
gift-wrapped DM) remains the only buyer-facing payment path until every gate
below is verified end-to-end.

## Trust model

- The server never holds keys. It records *who may unlock funds* (buyer,
  seller, optional arbiter) as a signed commitment, and durably tracks which
  payout actions are pending.
- The Cashu mint is trusted for proof validity and double-spend prevention,
  but only operator-configured mints are accepted.
- The arbiter (when named) is a 2-of-3 tiebreaker, chosen only from an
  operator-configured allowlist.

## Controls built in this change

### 1. Server-trusted commitment (`utils/cashu/escrow-commitment.ts`)

`POST /api/cashu/escrow/register` accepts only a buyer-signed Nostr event
(kind 31995) that binds, in one signature: seller pubkey, order id, amount
(sats), mint URL, expiry, and optional arbiter.

- Signature verified with `verifyEvent`.
- Event `content` must be the byte-exact canonical JSON of the signed tags —
  tag/content disagreement (e.g. tags pay seller A, content displays seller B)
  is rejected.
- `d` tag must equal `buyer_pubkey:order_id`, so a commitment cannot be
  transplanted onto another order.
- `created_at` must be within 600s — bounds replay of old signatures.
- Expiry must be in the future and ≤ 30 days out.
- Every signed tag must appear **exactly once** with exactly one value —
  duplicate `seller`/`amount`/`mint`/`d`/`arbiter` tags are rejected so no
  two components can ever read different occurrences.
- Mint URLs must be HTTPS (plain HTTP only for loopback dev mints).

### 2. Durable idempotent outbox (`utils/db/cashu-escrow-service.ts`)

- Registration is `INSERT ... ON CONFLICT DO NOTHING` on the derived escrow
  id: retries are no-ops; a *conflicting* re-registration (same id, different
  terms) is a 409, never a silent overwrite.
- Releases/refunds live in `cashu_escrow_outbox` (`pending → processing →
  done`) with **one row per escrow** (the outbox id IS the escrow id): the
  first enqueued action wins, the opposite action is rejected, so a release
  and a refund can never both become payable (tested, including racing
  opposite enqueues).
- Claims are atomic `UPDATE ... WHERE status` guards carrying a **fencing
  token**: each claim mints a fresh token, and finalize/release require it.
  A worker whose claim went stale and was reclaimed can no longer complete
  or abort the payout (tested). Finalization also requires the escrow to
  still be `locked`, so a double finalize fails instead of clobbering the
  resolution.
- A `processing` claim older than 15 minutes is reclaimable
  (`recoverStaleEscrowOutboxClaims`) — a process crash mid-payout cannot
  strand funds (recovery test: `requeues a stale claim and pays out exactly
  once`).
- **Honesty note:** the outbox alone cannot make an *external* mint payout
  exactly-once. A worker that crashes after paying the mint but before
  finalizing leaves a reclaimable row; the replacement worker MUST verify
  proof state at the mint (e.g. `checkProofsStates`) before re-paying. The
  fencing token guarantees only one worker can *record* the outcome.
- Failed attempts return to `pending` with the error recorded; the row is
  never deleted, so the outbox is the durable audit trail.
- State machine: a `released` escrow can never gain a `refund` and vice
  versa (enforced under `FOR UPDATE`).

### 3. Configured mints & arbiters (`utils/cashu/escrow-config.ts`)

- `CASHU_ESCROW_ALLOWED_MINTS` and `CASHU_ESCROW_ARBITER_PUBKEYS` are
  comma-separated env allowlists, parsed with strict validation (https URLs
  normalized; 64-hex pubkeys). Invalid entries are dropped, never trusted.
- `isEscrowEnabled()` requires `CASHU_ESCROW_ENABLED=true` **and** non-empty
  mints **and** non-empty arbiters. Anything less fails closed with 403.

### 4. Signer permissions, least privilege
(`utils/nostr/signers/nip46-permissions.ts`)

- The NIP-46 `connect` permitted-methods string is now an explicit, reviewed
  constant (`NIP46_BASE_PERMITTED_METHODS`) — byte-identical to the legacy
  list (pinned by test).
- The escrow commitment kind is requested **only** when
  `NEXT_PUBLIC_CASHU_ESCROW_ENABLED=true`; otherwise the bunker never sees
  the extra permission.

### 5. Schema parity

Both tables exist in the runtime bootstrap
(`utils/db/db-service.ts initializeTables`, authoritative for hosted envs)
and in `db/schema.sql` (self-host). Keep them in sync when migrating.

### 6. Payout worker (`utils/cashu/escrow-payout-worker.ts`,
`utils/cashu/escrow-payout.ts`, `POST /api/cashu/escrow/process`)

A cron-driven worker (internal scheduler, `FLOW_PROCESSOR_SECRET`-gated, no-op
unless escrow is enabled) drains the outbox:

- **Claim → pay → finalize, all fenced.** Each entry is claimed with a fresh
  fencing token; the payout executes; finalization requires the token and a
  still-`locked` escrow. Any failure calls `releaseEscrowOutboxClaim` with the
  error recorded, so entries retry instead of stranding. Stale claims are
  recovered every sweep via `recoverStaleEscrowOutboxClaims`.
- **Proof-state verification before EVERY payment attempt.** The executor
  (`executeEscrowPayout`) calls `checkProofsStates` at the mint before
  swapping — not just on retries — and fails closed unless the mint returns
  exactly one explicitly-`UNSPENT` state per input. This is the only
  double-pay guard for the external mint call; the outbox alone cannot
  provide it.
- **Two-phase swap with durable prepared outputs.** The swap runs as
  `prepareSwapToReceive` → persist the payee-locked output data to the
  outbox row (`prepared_outputs`, fenced by the claim token) →
  `completeSwap`. A crash after the mint accepted the swap therefore loses
  nothing: the retry finds the inputs SPENT and reconstructs the payee's
  proofs from the persisted blinded messages via the mint's NUT-09 `/restore`
  endpoint instead of paying again. Only SPENT-with-nothing-recorded (a
  crash before the first prepare persisted, which cannot have swapped) is
  left for operator reconciliation — and it still refuses to re-pay.
- **Signed payout proofs ride on the outbox row** (`payout_payload`). The
  server holds no keys: inputs arrive pre-signed by the entitled party
  (seller for release, buyer for refund), and the swap outputs are
  P2PK-locked to the payee, so custody of the result (`payout_outputs`,
  recorded transactionally at finalize) is safe.
- **Lock construction is validated against the commitment** before any mint
  call: locked to the committed seller, `locktime` == commitment expiry,
  `refund` = exactly the committed buyer, no multisig, no SIG_ALL (the
  keyless server cannot sign outputs), amount covers the commitment — and
  the P2PK tag set is allowlisted (`locktime`/`refund`/`n_sigs`/
  `n_sigs_refund`/`sigflag`), so a `pubkeys` tag cannot silently widen a
  seller-only lock into 1-of-2 and no future NUT-11 tag can sneak in
  semantics the worker never reviewed.
- **Expiry is re-checked at payout time**, and a release claimed after its
  window closed is atomically converted to a pending refund
  (`convertExpiredReleaseToRefund`, fenced by the claim token and
  conditional on actual expiry) instead of stranding the buyer behind an
  unpayable release row.
- **Failed entries back off exponentially** (1min, 2min, 4min, … capped at
  6h, in `listPendingEscrowOutboxEntries`), so a permanently-undeliverable
  entry cannot hot-loop the mint every sweep. Fresh entries are due
  immediately.
- **Expired locked escrows self-enqueue refunds** each sweep
  (`listExpiredLockedEscrows` → `enqueueEscrowAction(…, "refund")`).
  The enqueue is idempotent; when a release is already pending the one-row
  outbox rejects the refund, which is logged and skipped.
- Refunds enqueued by the sweep have no signed proofs yet; they pend (with
  `last_error` recorded) until the buyer's signed refund proofs are attached
  via `attachEscrowPayoutPayload` (atomic against concurrent claims). The
  signing endpoints are future work — see the checklist.

## Residual risks (must be closed before enabling)

1. **Proof custody**: registration records the commitment, but the P2PK-locked
   proofs themselves stay client-side until release/refund signing is wired.
   A buyer who loses their wallet backup before resolution loses the funds —
   recovery UX must land before the flag does.
2. **Arbiter key compromise** = misdirected release. Arbiter operations need
   their own signed-request binding when the resolution endpoint is built.
3. **Expiry race — handled by conversion**: the worker re-checks expiry at
   payout time; a release whose window closed mid-flight is atomically
   converted to a pending refund (see §6). Residual: none known, but this
   path MUST be covered by the staging kill-test below before enabling.
4. **Mint liveness**: refund-after-expiry depends on the mint being reachable;
   `listExpiredLockedEscrows` + retry backoff cover transient outages, not a
   dead mint. The NUT-09 restore recovery path likewise requires the mint to
   still serve the payout keyset.
5. **Crash between mint swap and finalize — recovered**: prepared payee-
   locked outputs are persisted before the mint call, and a retry
   reconstructs them via /restore (see §6). Residual: a mint that has
   forgotten the issued outputs (or dropped the keyset) still strands the
   payout in the "SPENT inputs, unrestorable outputs" state — detected and
   never re-paid, but requiring mint/operator reconciliation.

## Enabling checklist

- [ ] End-to-end recovery test in staging: kill the payout worker mid-release,
      confirm the outbox requeues and pays exactly once, and that the payee
      proofs are recovered via /restore.
- [ ] Buyer wallet recovery path for locked proofs (backup + restore verify).
- [ ] Arbiter resolution endpoint with signed-request binding.
- [ ] Signed release/refund request endpoints that collect the payee's P2PK
      signatures and attach them to the outbox entry
      (`attachEscrowPayoutPayload`).
- [ ] Delivery of `payout_outputs` to the payee after a payout finalizes.
- [ ] Buyer UI behind `NEXT_PUBLIC_CASHU_ESCROW_ENABLED`, off by default.
- [ ] Re-run this threat model against the final flow.
