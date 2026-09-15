---
name: Self-sown rename alias layer
description: the Milk Market -> Self-sown identifier rename is DONE (including wire contracts); the legacy milkmarket aliases that remain are deliberate compatibility contracts — never remove them
---

The full identifier rename (prose + code: packages, storage keys, TXT prefix, env var, mobile IDs, assets, Nostr discovery tags, mm_donation profile field, NIP-46 context, UCP namespace) is complete. Old identifiers that still appear in the codebase are intentional aliases, not leftovers.

**Rule:** treat every remaining `milkmarket`/`milk-market` identifier as a compatibility contract. New identifiers use compact `selfsown` (storage keys, schemes, discovery tags) vs kebab `self-sown` (packages, files, config).

**Why:** old browser tabs, saved wallets, existing seller DNS records, published Nostr events, and a lagging Stripe dashboard all still carry old identifiers; deleting an alias silently strands live money or breaks verification/checkout.

**How to apply:**

- Wire contracts were renamed with dual-compat, never hard-cut: writes publish new (`SelfSown`/`selfsown`/`self-sown-zapsnag` tags, `ss_donation`, `self-sown:nip46:v1`, `com.self-sown` UCP), reads accept BOTH old and new (fetch filters dual-match, donation dual-reads, NIP-46 legacy-context decrypt fallback). Replacement writers (republish helpers, MCP update) must route copied tags through `normalizeMarketplaceDiscoveryTag` so legacy tags are upgraded on any edit.
- Keep both code paths when touching a renamed surface (merge-migrate storage, dual-accept DNS/schemes, dual-read profile fields).
- Still NOT renamed by deliberate decision: `milk-market.replit.app` CNAME fallback, `milkmarket:` deeplink scheme + `milkmarket` NIP-05 alias, `FREEMILK` promo tag, Stripe `mm_*` metadata keys, external account URLs.
- Exception (hard-cut, Sept 2026): `milkmarket_*` Stripe Price lookup keys were retired (LEGACY\_\* constants + dual-read removed) only after the live platform account was verified to hold ZERO Prices — no legacy-keyed Price existed to conflict, so no dashboard rename was needed. Test-mode state was never verified (no test-mode key in Replit secrets). General rule still stands: never drop a Stripe lookup-key fallback while legacy-keyed Prices might exist, or find-or-create mints duplicate Prices.
