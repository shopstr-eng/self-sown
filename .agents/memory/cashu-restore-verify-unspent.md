---
name: Restore-from-backup must verify unspent
description: The manual "restore tokens from nostr backup" path must verify each proof unspent per issuing mint and fail-closed on unreachable mints, or it resurrects spent proofs as phantom balance.
---

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
