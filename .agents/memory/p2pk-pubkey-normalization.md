---
name: P2PK pubkey comparison must normalize compressed vs x-only
description: Mints emit P2PK lock pubkeys compressed (02/03 + x-only) while Nostr records carry x-only — normalize both sides before comparing, and write fixtures in the compressed form
---

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
