---
name: Cashu wallet boot-refresh clobber race
description: Why a long async wallet refresh can zero the wallet, and the delta-merge + empty-result-guard pattern that prevents it.
---

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
