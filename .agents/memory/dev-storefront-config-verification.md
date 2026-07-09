---
name: Dev storefront config verification
description: How to live-verify storefront config features in dev without a signer — edit the cached kind:30019 row.
---

The seller storefront config renders from the cached shop-profile event: table `profile_events`, kind `30019` (pubkey via `shop_slugs`). The stall page HTML shell is client-rendered (curl shows no nav/hero), so verification must go through a browser screenshot.

**How to apply:** To test a config-driven render path in dev, UPDATE that row's `content` JSON directly, screenshot `/stall/<slug>`, then restore the saved original content. Two gotchas:

- Prove the DB copy is the render source by also changing a visible marker (e.g. shop `name` → "… ZZ") — relay/IndexedDB copies can win races.
- When testing color/transparency behavior, inject loud `navColors` (e.g. red bg) so "transparent" is distinguishable from "same dark color as the hero".

**Why:** dark nav over dark hero made a working transparent-nav feature look like a no-op; the marker + red-bg trick disambiguated in two screenshots. Also note: the landing nav pad only applies when the seller has custom nav links (`hasNav`), so default-link shops show no layout shift either way.
