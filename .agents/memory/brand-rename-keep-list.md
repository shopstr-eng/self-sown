---
name: Brand rename keep-list
description: During the Milk Market → Self-sown rename, these identifiers were deliberately NOT renamed — renaming them breaks external contracts or user data
---

# Brand rename keep-list (Milk Market → Self-sown)

Only spaced/title-case brand prose ("Milk Market", "MILK MARKET") was renamed. These spaceless identifiers MUST keep the old name:

- `milkmarket://` mobile deep-link scheme — baked into installed mobile apps and Stripe Connect return/refresh URLs.
- `_milkmarket.<domain>` DNS TXT prefix — existing seller domain verifications depend on it.
- localStorage keys `milkmarket.pendingMintQuotes`, `milkmarket.outgoingSendTokens` — renaming orphans user wallet state.
- Stripe lookup key `milkmarket_wrangler_lifetime_v1` — must match the Stripe dashboard Price.
- Env var names `NEXT_PUBLIC_MILK_MARKET_PK`, `NEXT_PUBLIC_BEEF_INITIATIVE_NPUB` — secrets/config are keyed by these names.
- npm package names / Expo slug (`milk-market`, `milk-market-mobile`), GitHub repo URLs, `milkmarket@` NIP-05 handle, and public asset filenames (public/milk-market.png etc. — logo swap is a separate follow-up).

**Why:** a rename that touches these either breaks live integrations (Stripe, DNS verification, deep links) or silently destroys user data (storage keys).

**How to apply:** for any future rename or brand audit, sed only the spaced brand forms, then scan with a whitespace-tolerant multiline pattern (`Milk\s*\n\s*Market` style) — single-line sed misses JSX-wrapped prose (4 occurrences survived the first pass this way). A guard test for this is tracked as a follow-up task.
