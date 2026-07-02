---
name: shop-profile-form triple load path
description: The seller storefront form loads config from three racing sources; any code that mutates form state after load must guard against all of them.
---

# shop-profile-form has racing load paths — guard mutations against all of them

`components/settings/shop-profile-form.tsx` hydrates the form from THREE sources
that resolve in a non-deterministic order:

1. **Fast path** — DB fetch (`/api/storefront/lookup`), applies via
   `applyShopConfig`, clears the spinner (`isFetchingShop=false`). Guarded by
   `contextLoadedRef`.
2. **Slow path** — authoritative relay/`ShopMapContext` data; runs `reset()` +
   all setters to OVERRIDE the fast path. Guarded only by `hasLoadedShopRef`.
3. **Safety valve** — 12s timeout that just clears the spinner.

**The gotcha:** any effect that writes form state _after_ load (e.g. the
website-import draft handoff keyed on `?importDraft=1` + localStorage) can be
silently clobbered by the slow path arriving later. On a hard refresh the fast
path resolves first → import applied + draft deleted → relay arrives → slow path
`reset()`s back to the seller's OLD stored design, and the draft is already
gone. Fix: such effects set a run-once ref (`importHydratedRef`) BEFORE clearing
their source, and the slow-path effect early-returns when that ref is set.

**Why:** caught in review of the URL-import feature; gating the import effect on
`isFetchingShop===false` alone is insufficient because the slow path isn't tied
to that flag.

**How to apply:** when adding any post-load form mutation here, (a) wait for
load (`!isFetchingShop`), (b) run once via a ref set before side effects, and
(c) make the slow-path override respect your ref so it can't overwrite you.
Merge onto existing config; don't touch `pages`/`blogPage`/`emailPopup`/
`productPageDefaults` unless that's the explicit intent.
