---
name: Cashu wallet rules
description: Wallet invariants — mint amount source, post-swap recovery, multi-mint attribution, spent-proof handling, boot-refresh race, restore verification, send-token ledger.
---

The `amount` passed to `wallet.mintProofsBolt11(amount, hash)` must be the same value that was used to create the mint quote (`createMintQuoteBolt11`). The mint rejects the claim if these differ, even by 1 sat.

**Why:** In cart Lightning/NWC payment handlers, the mint quote was being created for `convertedPrice` (== `bitcoinCosts.satsTotal` from `getMethodDiscountedCosts`, which applies bitcoin payment-method discounts on top of any discount code) but the claim call was passing the `totalCost` React state variable. When a buyer used a discount code together with a bitcoin payment-method discount, the two diverged and the mint rejected `mintProofsBolt11`, leaving the buyer in the polling loop with no proofs.

**How to apply:** In every Lightning handler (`handleLightningPayment`, `handleNWCPayment`, equivalents on new payment surfaces), thread the same local `convertedPrice` (or whatever variable was used for `createMintQuoteBolt11`) all the way into `invoiceHasBeenPaid` → `mintProofsBolt11`. Never substitute a React state variable like `totalCost` that can be recomputed by other effects mid-flow.

A successful `wallet.swap(...)` (or `wallet.meltProofs(...)`) marks the input proofs SPENT at the mint and returns new UNSPENT outputs (`keep` / `send` / `changeProofs`). If the calling flow throws **after** that point but **before** the new outputs are written to `localStorage["tokens"]`, the user's wallet ends up holding only the spent inputs — Lightning sends then fail with "insufficient" and ecash exports fail at the receiving wallet with "proofs already spent". This was the actual root cause of the 48k phantom-balance incident, not the recovery-stash path.

**The rule:** every code path that calls `safeSwap` / `safeMeltProofs` must hold a `postSwapRecovery = { mintUrl, proofs }` variable that is updated as the flow progresses, and the outer `catch` must call `stashProofsLocally(proofs, mintUrl, ...)` when it is non-null. Narrow `proofs` as parts of the work get committed (`localStorage.setItem("tokens", ...)`, downstream distribution succeeds, encoded token is shown to the user) and set it to `null` only when nothing remains recoverable.

**Why:** the mint is the source of truth for spent-ness; the local wallet is the only source of truth for the unspent replacements. Losing the replacement is irreversible from local state alone. Stashing duplicates of already-saved change is fine (`persistReceivedTokens` dedups by secret); not stashing a real replacement is permanent loss.

**The mint URL must be the actual spend mint, not `mints[0]`.** In multi-mint wallets the spend mint is chosen per-payment by `pickMintForPayment` and can differ from the default. Stashing recovered proofs under `mints[0]` mis-attributes their keysets and they present as an unusable balance. Any distribution helper that wraps a swap+melt pipeline and throws a `SendTokensRecoverableError` (or equivalent) **must** be passed the spend mint explicitly by its caller and include it on the error — do not let the helper fall back to `mints[0]`.

**Catch precedence when both apply:** prefer the error's `recoverableProofs` over the outer `postSwapRecovery.proofs`, because the in-helper tracker reflects mid-distribution state (some proofs already transmitted to the recipient and no longer recoverable by the buyer). Fall back to `postSwapRecovery` only when the throw happened outside the helper.

**UI nuance for "send a token" flows:** persist `keep` to localStorage _before_ surfacing the encoded `send` token to the user. Once the user can see (and copy) the encoded token, the `send` proofs are theirs to deliver and the recovery slot for them must be cleared, otherwise a downstream throw would double-credit the wallet against a token already in the user's clipboard.

**Audit tip:** when checking coverage, grep for ALL `safeSwap`/`safeMeltProofs` callers — the claim-button (claim-a-token-from-a-message → redeem-to-Lightning) was a missed caller for a long time: it swapped the claimed token's proofs (spending the original) and its catch discarded keep/send/change entirely. Melt-outcome branch values: unpaid → keep+send; pending/unknown → keep only (send may still be consumed); paid → keep+change until the change is durably delivered.

The Cashu wallet stores proofs in `localStorage["tokens"]` as a flat array; mint membership is _not_ on the proof itself. To attribute a proof to a mint you must match `proof.id` against that mint's `keyChain.getKeysets()` ids — there is no other reliable source.

**Why:** proofs were repeatedly displayed as "0 sats" on the wallet/storefront pages because the UI loaded keysets for `mints[0]` only, then filtered tokens by those keyset ids. Any proof from another mint (or any timing where keysets hadn't loaded yet) silently dropped out of the balance even though the user's funds were intact.

**How to apply:**

- Default mint = `mints[0]`. Any code path that credits the local wallet (receive, claim, mint, recovery, post-spend change) must promote its source mint to index 0 via `persistReceivedTokens` so the UI's keyset lookup attributes the new proofs correctly.
- When spending, never hardcode `mints[0]`. Use `pickMintForPayment(amount, mints, tokens)` — it probes each mint's keysets and picks the first that can cover the amount. Pass the chosen mint to both the swap _and_ `publishProofEvent`, otherwise the next reverse-attribution (kind 7375 proof events → mint) is poisoned.
- Balance fallback while keysets are unloaded: for single-mint wallets show the token total; for multi-mint wallets preserve the previous balance rather than flashing 0. Pair this with a keyset reload retry (token-count change + periodic tick) so a one-off `loadMint` failure cannot leave the balance stuck stale forever.
- Reactive reads of `localStorage` must JSON-dedup before calling state setters; otherwise a polling reload re-fires `loadMint` every tick and the resulting in-flight resets produce transient wrong balances.

Any recovery path that stashes cashu proofs into `localStorage["tokens"]` (failed-payment recovery, stash-on-throw, etc.) can stash proofs that are already SPENT at the mint. Once stashed, they present as a phantom balance: sends fail with "insufficient" (mint refuses to swap spent inputs) and ecash exports fail at the receiving wallet with "proofs already spent".

**Tempting fix that DOES NOT WORK on auto-run:** call `wallet.checkProofsStates(...)` on mount, treat any `state === "SPENT"` as deletable, prune from localStorage.

**Why auto-pruning is banned:** A first attempt that auto-pruned on wallet mount silently deleted a user's full balance — root cause was either a mint mis-reporting state or our probe matching proofs we shouldn't have. Spent-proof pruning of locally-stored cashu funds is irreversible from local state alone; the user has no undo. Treat it as a destructive operation and require explicit user opt-in (a button + confirmation) before running. Do **not** wire it into a `useEffect` on mount, and do **not** fire-and-forget it from recovery stash paths.

**How to apply (if you do build an opt-in sweep button):**

- Only probe proofs whose keyset id belongs to the mint being asked. `checkProofsStates` on foreign proofs is invalid.
- On any probe error, leave proofs intact — a transient mint outage must never delete user funds.
- **Merge-safe write**: probe a snapshot, but at write time _re-read_ the latest tokens and remove only confirmed-spent secrets. Never write the snapshot back wholesale — overlapping receives/mints/stashes would be clobbered.
- Hold a per-tab in-flight lock so overlapping sweep calls serialize on one probe + write.
- Quarantine pruned proofs to a separate `localStorage` key (don't truly delete) so the user can roll back if the mint was wrong.

**Always have an out-of-band recovery path.** Local tokens are not the only copy: every "in" proof is also published as a kind-7375 nostr event and cached in Postgres. Expose a "Restore wallet from nostr backup" button that calls `restoreTokensFromProofEvents(walletContext.proofEvents)` — merge-only, dedup by secret, never deletes. This is what saves users when any pruning/recovery logic goes wrong, and what we landed instead of an auto-sweep.

# Cashu wallet boot-refresh clobber race

A wallet refresh that **snapshots `localStorage["tokens"]` at the top and then
does seconds of async work** (DB/relay fetch + per-mint `checkProofsStates` +
deleteEvent) before writing the result back can **zero the wallet**: if a
send/melt completes during that async window it spends the old proofs and writes
fresh CHANGE proofs to localStorage the refresh never saw, so the refresh
resolves with a stale/empty set and clobbers the change.

**The two-part fix (both required):**

1. **Delta-merge before publishing** (inside the refresh, e.g. `fetchCashuWallet`):
   just before `editCashuWalletContext`, re-read current localStorage and add
   back any proof NOT proven spent this run. Guard with a `spentSecrets` set
   populated from BOTH the per-mint `checkProofsStates` SPENT set (index-aligned
   with `Ys`) AND spending-history `destroyedProofs`, so a proof genuinely spent
   this run can never reappear as phantom balance.
2. **Empty-result write guard** at EVERY wallet write site (there are 3 in
   `_app.tsx`): skip the `tokens` setItem when the fetch result is empty AND
   current localStorage is non-empty. Writing empty mints separately is fine;
   it's the tokens clobber that loses funds.

**Why:** Snapshot-then-write across an async boundary is a lost-update race on
shared localStorage. The delta-merge only ever adds back proofs the wallet
ALREADY held, so it introduces no NEW phantom balance; anything genuinely spent
externally is pruned by the periodic self-heal sweep. Direction of failure is
always toward keeping funds, never dropping them.

**How to apply:** Any code that reads localStorage tokens, awaits, then writes
the derived set back must re-read + delta-merge at the write site (minus
proven-spent secrets), and callers must never blindly persist an empty refresh
result over a non-empty wallet. Architect validated this composes safely with
the self-heal sweep (sweep re-reads latest + has a per-tab in-flight lock).

# Restore-from-backup must verify unspent

The manual "restore wallet from nostr backup" flow rebuilds
`localStorage["tokens"]` from the user's kind-7375 proof events. Those events are
an append-only log of every proof ever created — **many are already SPENT**.
Blindly merging them back in re-creates phantom balance (symptom: spent tokens
reappear).

**Required shape of restore (`restoreTokensFromProofEvents`):**

- Group candidate additions (new secrets only) **by their issuing mint**.
- Verify each mint's candidates UNSPENT via `filterUnspentProofs` (returns
  `{unspent, spentCount, checked}`; `checked===false` on probe failure and
  leaves proofs intact).
- **Fail-closed:** if a mint can't be probed (`checked===false`), SKIP its
  proofs and report a `skippedCount`/`skippedMints` so the UI can say "mint
  unreachable, try again". Do NOT restore unverifiable proofs.
- Drop mint-reported SPENT proofs; only add mints that actually contributed
  kept proofs to the configured mint list.
- Re-read localStorage before the write and dedupe by secret (the per-mint
  probes make this async, so a concurrent write can land).

**Why:** No data loss from fail-closed — the proof events persist on
relays/Postgres, so a skipped restore is retryable; but restoring an unverified
proof risks charging/showing money that isn't spendable. Prefer "try again"
over silently resurrecting spent value.

**How to apply:** Making a restore/import path async to verify against a mint
means every caller must `await` it and surface the skipped count. Known accepted
gap (non-blocking, self-healed by the sweep): `filterUnspentProofs` passes
proofs whose keyset id doesn't belong to the probed mint through UNVERIFIED, so a
backup event with a mis-attributed mint could restore spent proofs — low
likelihood since mint+proofs are stored together in the kind-7375 event.

# Cashu send-token ledger + reclaim

Every token generated by the wallet Send button is durably recorded in a localStorage ledger (`milkmarket.outgoingSendTokens`) BEFORE the token is ever displayed, while the send proofs are still recoverable (`postSwapRecovery` in the send flow still holds them). If the ledger write throws, the catch stashes the send proofs back — fail-closed: a token must never exist only in ephemeral React state.

**Why:** a user lost ~52k sats because a Send-generated token lived only in component state; once the modal closed there was no record and no reclaim path.

**Rules:**

- Unclaimed entries are never pruned; resolved (claimed/reclaimed) entries prune after 30 days.
- **Reclaim must SWAP, never re-persist.** Reclaiming an outstanding token must go through `wallet.receive({mint, proofs})` so the mint issues fresh secrets and the original token is invalidated — anyone holding the token string (clipboard, DM, intended recipient) can otherwise still race the user and win, since reclaimed proofs sit passively in the wallet. Mark `reclaimed` only on swap success; on swap failure leave `unclaimed` (retryable).
- Never show a Copy affordance for a reclaimed entry — the string is a live claim on the user's own balance.
- All-spent → mark `claimed`; mint unreachable (`checked: false` from filterUnspentProofs) → leave `unclaimed`, fail-closed.
- No kind-7375 double-count: send proofs were never backed up as "in" before; reclaim's backup is their first, and both persist + restore paths dedup by secret.

**How to apply:** any new surface that hands a cashu token string to the user (or an external party) must record it in this ledger the same way; any reclaim/recovery feature must swap at the mint before crediting the wallet.
