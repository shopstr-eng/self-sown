---
name: Default Cashu mint
description: the platform default mint (mint.minibits.cash) lives in packages/domain; fresh mobile accounts default to it, but an explicitly saved list — even empty — always wins.
---

The platform default Cashu mint is `DEFAULT_CASHU_MINT_URL`
("https://mint.minibits.cash/Bitcoin") in packages/domain/src/constants.ts.
Both server-side allowlists (utils/ucp/order-service.ts DEFAULT_MINT_URL /
ALLOWED_MINT_URLS re-export it) and mobile account preferences source from
there — never hardcode a mint URL elsewhere.

Mobile semantics (apps/mobile/lib/account-settings.ts readMints): the
per-pubkey AsyncStorage key being ABSENT means "fresh account" → return the
default mint so Lightning works with zero setup. A SAVED list always wins —
including a saved empty list, which means the seller deliberately removed
every mint and must not get the default back. Corrupt stored JSON and
storage errors also fall back to the default (fail open for payments).

**Why:** a seller with no NWC wallet and no mint had no working Lightning
path at all; the PoS fallback mints the invoice from mints[0] and funds land
as ecash claimable in Settings. But re-adding a removed mint silently would
be a settings-integrity bug, so absence and emptiness must stay
distinguishable.

**How to apply:** when adding another mint consumer, import
DEFAULT_CASHU_MINT_URL from @self-sown/domain. When changing mobile mint
defaults, preserve the absent-vs-saved-empty distinction (readStringList
collapses both to [] — use readMints). The web settings page
(pages/settings/account.tsx) stores mints in localStorage and does NOT yet
apply this default.
