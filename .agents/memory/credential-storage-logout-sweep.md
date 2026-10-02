---
name: New credential-bearing storage keys must join the logout sweep
description: Any new localStorage/sessionStorage key that holds a credential (passphrase, key material) must be removed by LogOut() in nostr-helper-functions.ts, and per-account keys need exact-key cleanup in the signer.
---

LogOut() in `utils/nostr/nostr-helper-functions.ts` removes a fixed key list
plus every `remembered-passphrase:*` sessionStorage entry by prefix scan. Any
future storage key holding credential-like material must be added to that
sweep or the credential survives logout in the tab.

Two related traps, both caught by review:

- Per-account keys (`...:<pubkey>`) can't be enumerated in a constants list —
  sweep by prefix.
- A signer may write its storage entry before its pubkey is known (legacy
  signer JSON), so cleanup must remove the _recorded_ key (tracked in a field
  at write/read time), not a key recomputed from `this.pubkey` which may have
  been resolved later. `clearRememberedPassphrase()` in nostr-nsec-signer.ts
  does both.

**Why:** the "remember passphrase for this session" feature stored a plaintext
unlock passphrase in sessionStorage; the first implementation leaked it past
logout and orphaned the `:default` fallback entry once the pubkey resolved.

**How to apply:** when adding any persisted credential or session-scoped auth
state, (1) add it to the LogOut sweep, (2) write regression tests for logout,
unknown-pubkey-at-write-time, reload restore, stale-value recovery, and
opt-out (remember=false).
