---
name: Staging escrow E2E seed coupling
description: the e2e-setup-staging-seller seed string deterministically derives the naddr hardcoded in e2e-escrow-recovery.mjs — renaming the seed silently breaks the recovery harness default
---

`scripts/e2e-setup-staging-seller.mjs` derives its fixture seller keypair from `sha256(<seed string>)` and the listing d-tag from `sellerSk.slice(0,4).join("")`. `scripts/e2e-escrow-recovery.mjs` hardcodes a default `LISTING_ID` naddr encoding both.

**Rule:** any change to the seed string must re-derive and update the recovery harness naddr in the same commit.

**Why:** the naddr is opaque — grep cannot reveal the coupling, and the break only surfaces after a DB rebuild + setup rerun, contradicting the harness's "survives DB wipes" contract. Caught only by code review during the rebrand seed rename.

**How to apply:** decode the old naddr (`nip19.decode`), derive the new keypair/d-tag with the setup script's exact expressions, re-encode with identical kind/relays (`nip19.naddrEncode`), and update `LISTING_ID`.
