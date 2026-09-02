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

## Buyer-facing flow (behind `NEXT_PUBLIC_CASHU_ESCROW_ENABLED`, off by default)

- **Double opt-in**: the checkout toggle renders only when the deployment flag
  is on AND the seller's storefront config sets `acceptsEscrow: true`
  (opt-IN, persisted only when true so existing shop events stay byte-stable).
  The eligibility check is re-run inside the payment handler, so a stale UI
  state fails loudly instead of silently degrading to a direct payment.
  Direct Cashu checkout remains the default; escrow is never forced.
- **Commitment before funds move**: the buyer signs the kind-31995 commitment
  and `POST /api/cashu/escrow/register` must succeed BEFORE any proofs are
  swapped into the P2PK lock (data = seller pubkey, locktime = expiry, refund
  = exactly the buyer, SIG_INPUTS — the construction the payout worker
  validates). Multi-product single-seller carts register one commitment per
  product slice, keyed `<orderId>:<productId>` to avoid id collisions.
- **Custody stays with the buyer**: the locked proofs are NEVER sent to the
  seller. The seller's payment message references the escrow id (payment type
  `escrow`, no token), so the seller cannot redeem the funds unilaterally
  before expiry — funds move only through the signed release/refund payout
  flow. The buyer retains the locked token in their localStorage escrow
  record (written fail-closed at checkout; a failed write aborts loudly and
  the recoverable-proof tracker stash keeps the funds recoverable) and signs
  its P2PK witnesses when triggering a refund.
- **Status**: `GET /api/cashu/escrow/status?escrowId=…` is unauthenticated but
  rate-limited; the escrow id embeds the buyer pubkey and a high-entropy order
  id, so knowing it is proof of involvement. It returns status, expiry, the
  escrow's mint, and any pending outbox action — never amounts. Once a payout
  has completed it also returns the payout proofs, which are P2PK-locked to
  the PAYEE (buyer for refunds, seller for releases) and therefore useless to
  anyone else. While a buyer-approved release awaits the seller's witness it
  reports `releaseAwaitingSeller` and serves the raw locked proofs (seller-
  locked pre-expiry, so unspendable by anyone else) for the seller to sign.
- **Refund trigger**: `POST /api/cashu/escrow/refund` takes a buyer-signed
  kind-31996 action event (canonical content, unique tags, 10-minute
  freshness window, signer bound to the escrow's buyer prefix) together with
  the buyer-retained locked proofs carrying the buyer's P2PK witness. The
  endpoint re-checks the buyer against the registration, requires actual
  expiry, validates the proofs against the commitment
  (`validateEscrowPayoutProofs` — the same validator the payout worker runs),
  then enqueues the refund and attaches the payload
  (`attachEscrowPayoutPayload`) in one request, so a 200 means the refund can
  actually complete. Idempotent, and a conflicting pending release is a 409,
  never a silent flip. Payload-less pending refunds (auto-enqueued by the
  expiry sweep, or left by a lost enqueue/claim race) stay completable: the
  status endpoint reports `payloadAttached`, the buyer UI keeps the refund
  control until the payload lands, and the endpoint retries the attach once
  across a claim race and only reports success once attachment succeeds.
  Refund witness signing requires a key-based signer; remote (NIP-46)
  signers fail loudly with instructions.
- **Release**: two-step. The buyer approves early via
  `POST /api/cashu/escrow/release-approve` (buyer-signed kind-31996 action
  event, pre-expiry only, structural proof check with witnesses deferred —
  only the seller's key can produce them) and the raw locked proofs are
  stored on the outbox at stage `awaiting_seller_witness`; the payout
  worker's claim atomically skips that stage, so an unwitnessed release can
  never be attempted (no burned attempts, no claim churn). The seller
  completes via `POST /api/cashu/escrow/release` with the seller-witnessed
  proofs, re-validated with the worker's full validator and re-attached at
  stage `ready`. Both endpoints authorize the signer against the registration
  (DB is authoritative), replay completed releases with the payout token, and
  409 on a conflicting pending refund. The seller's orders-dashboard payment
  cell (payment type `escrow`, reference = escrow id) drives the witness and
  redeem steps in app; witness signing requires a key-based signer, same as
  refunds.
- The buyer's escrow records live in localStorage (deduped by escrow id,
  NEVER truncated — each record holds the only custody material, so eviction
  could strand funds; terminal records are pruned only after release or
  refund+redeem) and render on the orders page with the refund trigger and a
  refund-redemption button once the payout lands.

## Residual risks (must be closed before enabling)

1. **Proof custody — mitigated**: the P2PK-locked proofs live in the buyer's
   localStorage escrow record AND are backed up to the buyer's own kind-7375
   wallet events at checkout (`publishEscrowBackup`, best-effort; the wallet
   pages re-publish any missing backup on visit). Escrow-marked backups are
   excluded from the spendable-wallet paths (boot fetch, token restore) and
   restore rebuilds the `cashu_escrows` record with per-mint UNSPENT
   verification, fail-closed on unreachable mints. Restore reports any
   escrow whose proofs could not be recovered with the order id, amount, and
   a "contact support before expiry" pointer. Residual: a backup publish
   that never succeeds (offline buyer who also loses the device before
   visiting the wallet page) still strands the funds.
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
- [x] Buyer wallet recovery path for locked proofs: kind-7375 backup at
      checkout (+ wallet-page re-publish of missing backups) and restore with
      per-mint UNSPENT verification; unrecoverable escrows are reported with
      a contact-support-before-expiry pointer.
- [ ] Arbiter resolution endpoint with signed-request binding.
- [x] Refund: `/api/cashu/escrow/refund` collects the buyer-witnessed locked
      proofs, validates them against the commitment, and attaches them to the
      outbox entry (`attachEscrowPayoutPayload`) atomically.
- [x] Release: buyer-approved via `/api/cashu/escrow/release-approve` (raw
      proofs staged `awaiting_seller_witness`, unclaimable by the worker),
      seller-completed via `/api/cashu/escrow/release` (seller-witnessed
      proofs, full validation, re-attached at stage `ready`).
- [x] Refund delivery: the status endpoint returns the buyer-locked payout
      token once a refund finalizes; the orders page redeems it in-app.
- [x] Release delivery: the status endpoint returns the seller-locked payout
      token once a release finalizes; the orders dashboard redeems it in-app.
- [x] Buyer UI behind `NEXT_PUBLIC_CASHU_ESCROW_ENABLED`, off by default
      (checkout toggle, status + refund trigger; see "Buyer-facing flow").
- [ ] Re-run this threat model against the final flow.
