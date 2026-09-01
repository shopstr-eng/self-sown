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

## Residual risks (must be closed before enabling)

1. **Proof custody**: registration records the commitment, but the P2PK-locked
   proofs themselves stay client-side until release/refund signing is wired.
   A buyer who loses their wallet backup before resolution loses the funds —
   recovery UX must land before the flag does.
2. **Arbiter key compromise** = misdirected release. Arbiter operations need
   their own signed-request binding when the resolution endpoint is built.
3. **Expiry race**: a release claimed just before expiry vs. an auto-refund
   sweep is serialized only by the outbox state machine; the release worker
   must re-check expiry at signing time.
4. **Mint liveness**: refund-after-expiry depends on the mint being reachable;
   `listExpiredLockedEscrows` + retry backoff cover transient outages, not a
   dead mint.

## Enabling checklist

- [ ] End-to-end recovery test in staging: kill the payout worker mid-release,
      confirm the outbox requeues and pays exactly once.
- [ ] Buyer wallet recovery path for locked proofs (backup + restore verify).
- [ ] Arbiter resolution endpoint with signed-request binding.
- [ ] Buyer UI behind `NEXT_PUBLIC_CASHU_ESCROW_ENABLED`, off by default.
- [ ] Re-run this threat model against the final flow.
