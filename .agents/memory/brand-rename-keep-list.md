---
name: Self-sown rename alias layer
description: the Milk Market -> Self-sown identifier rename is DONE; the legacy milkmarket aliases that remain are deliberate compatibility contracts — never remove them
---

The full identifier rename (prose + code: packages, storage keys, TXT prefix, Stripe lookup keys, env var, mobile IDs, assets) is complete. Old identifiers that still appear in the codebase are intentional aliases, not leftovers.

**Rule:** treat every remaining `milkmarket`/`milk-market` identifier as a compatibility contract. New identifiers use compact `selfsown` (storage keys, schemes, lookup keys) vs kebab `self-sown` (packages, files, config).

**Why:** old browser tabs, saved wallets, existing seller DNS records, published Nostr events, and a lagging Stripe dashboard all still carry old identifiers; deleting an alias silently strands live money or breaks verification/checkout.

**How to apply:** when touching a renamed surface, keep both code paths (merge-migrate storage, dual-accept DNS/schemes/lookup keys, env `||` fallback). Never mechanically rename Nostr event tags, Stripe `mm_*` metadata keys, or external account URLs — those are protocol/externally-owned identifiers, not brand text.
