---
name: Cashu escrow rules
description: Escrow invariants — buyer custody, outbox fencing + worker validation, backups excluded from balance, P2PK pubkey normalization, backup encryption failure surfacing.
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
10. **Multi-row escrow transactions lock the outbox row BEFORE the registration row.** finalizeEscrowOutboxEntry updates outbox → registration; enqueueEscrowAction takes the existing outbox row FOR UPDATE first (first-ever enqueue finds no row and takes no lock — nothing can finalize a nonexistent entry), then the registration. Single-statement updaters (claim, claim-release, attach, conversions) are order-free.
    **Why:** enqueue used to lock registration → outbox (AB-BA vs finalize); a refund enqueue racing a release finalize was deadlock-aborted by Postgres — fail-closed, but it sporadically killed a legitimate payout until the retry sweep.
    **How to apply:** any new transaction touching both tables takes the outbox lock first; the finalize-enqueue racing test asserts no deadlock-tolerant branch remains.

In Cashu escrow, the P2PK-locked proofs (primary key = seller, refund key = buyer after locktime) are NEVER sent to the seller at checkout: the seller's key can redeem an ACTIVE lock immediately, so delivering the token is a pre-expiry handover, not escrow. The buyer keeps custody client-side — the record write is fail-closed at checkout and records are never truncated, since each is the only custody material for a possibly-unresolved escrow (prune only after resolution). Payment messages/receipts reference the escrow by id under a non-token payment type; the orders/chat UI only treats the plain ecash type as spendable. Funds move only through the signed payout flow: the entitled party (seller pre-expiry, buyer post-expiry) witnesses the proofs and attaches them to the one-row outbox, which a keyless worker pays out.

**Why:** a single checkout branch that ships the token breaks escrow for that path, and any payout entry the entitled party cannot complete strands funds permanently — every pending stage needs an owner who can advance it at every point in the lock's lifetime, including after expiry.

**How to apply:** new checkout message/receipt branches must go through the escrow conditional (pinned by the escrow-custody source-invariant test). New payout legs follow the signed-attach pattern: never report success before the attach lands, surface enough status for the entitled party to complete or retry, and any seller-owned pending stage that can outlive the lock must convert to the buyer's refund at expiry.

# Escrow backups are not wallet balance

Buyers' escrow-locked proofs (P2PK: seller pre-expiry, buyer refund after)
are backed up to the buyer's own kind-7375 wallet events, tagged with an
`escrow` metadata object in the encrypted content, with NO spending-history
event.

**Rule:** every consumer of kind-7375 proof events must branch on the
`escrow` marker. Escrow-marked proofs must NEVER enter the spendable wallet
(token storage, the boot fetch's proof accumulation, spending-history
add-back), and escrow backup events must not be auto-deleted by the
fully-spent-event cleanup. Restore rebuilds the buyer's escrow record with
per-mint UNSPENT verification (fail-closed) and requires the FULL locked set
— the payout validator needs the exact committed amount, so a partial
restore is reported unrecoverable instead.

**Why:** locked proofs in the wallet inflate the balance with funds the
buyer cannot spend before expiry (and the seller can), and spend selection
would try to use them and fail. Deleting spent backups would destroy
recovery material for unresolved escrows.

**How to apply:** the wallet boot fetch ingests kind-7375 from BOTH the
database cache and relays (publish caches to the DB first, so the DB branch
may be the only place a fresh backup appears) — any change to one branch
must be mirrored in the other. Any new kind-7375 consumer must skip
escrow-marked events, and new buyer-escrow-record fields must be mirrored in
the backup metadata or restore can't rebuild the record.

A P2PK secret's `data` field as emitted by real mints is the compressed SEC
form (66 chars, `02`/`03` + x-only), while Nostr-side records store the bare
x-only pubkey (64 chars). Raw string equality between the two always fails for
real mint-issued proofs.

**Why:** a validator comparing them directly rejected every real backup while
all x-only fixtures passed — the mismatch only exists with real mint output,
so it survives any amount of fixture-based testing.
**How to apply:** any comparison between a P2PK secret field and a Nostr
pubkey (validation, ownership, witness matching) must normalize both sides
through the shared `normalizeP2PKPubkey` helper; write test fixtures in the
`02`-prefixed compressed form mints actually emit.

NIP-46 signers in this app CAN encrypt to self (nip44_encrypt RPC, requested in the base permitted-methods list at connect), but the capability is bunker-dependent: nip04-only bunkers or denied permissions reject the RPC. NIP-07 is guarded at construction (requires window.nostr.nip44); nsec has built-in nip44.

**Rule:** an escrow backup publish failure must always reach a buyer-visible surface. `publishEscrowBackup` returns `{ published, failure? }` with failure ∈ unavailable / encryption_failed / publish_failed; `republishMissingEscrowBackups` reports `unbacked` records with reasons. Checkout cards and both wallet pages render `describeEscrowBackupWarning(failure)` — never swallow to console.warn alone.

**Why:** a silently-missing kind-7375 escrow backup is a recovery path that doesn't exist; a buyer who loses their browser strands the locked proofs. encryption_failed is permanent for that signer, so republishMissingEscrowBackups session-caches give-ups — but ONLY for demonstrated capability/permission rejections (isPermanentEncryptionFailure message match; transport errors classify publish_failed and keep retrying). All session state (give-up + in-flight) is per-signer WeakMap<object, Set>: same-pubkey signer swaps must publish immediately, and a late failure must bind to the signer that produced it. Records are also filtered to the signer's own pubkey — the local store is shared across accounts in a browser profile, so an account switch must never encrypt/publish the previous account's locked proofs.

**How to apply:** any new caller of publish/republish must handle the typed result and surface the warning; new failure modes get a new EscrowBackupFailure variant, not a bare false.

**Render-surface rule:** the warning must render in a view the ACTIVE payment path actually shows. Both checkout cards have an invoice view gated on `showInvoiceCard` that only the Lightning handlers open — a banner rendered only there was invisible to direct Cashu escrow payments (state set, never displayed). The banner now also renders in the main payment view of both cards.

**Why:** setting state is not surfacing; check which views each payment path (Lightning vs direct Cashu vs fiat) opens before placing a warning.
