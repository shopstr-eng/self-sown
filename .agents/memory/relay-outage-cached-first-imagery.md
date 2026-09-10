---
name: Relay-outage cached-first imagery
description: Profile/shop/product fetches must seed from the DB cache first and treat relays as a bounded freshness upgrade; never wipe seeded context on relay failure.
---

Profile, shop-profile, and product fetches (fetchProfile / fetchShopProfile / fetchAllPosts / fetchStorefrontData) seed the React context from `/api/db/fetch-profiles` / `/api/db/fetch-products` FIRST, then fetch relays as a freshness upgrade.

Rules when touching these paths:

- Every relay fetch in a cached-first path must pass `{ resolveOnTimeout: true, timeout: CACHED_FIRST_RELAY_TIMEOUT_MS }` (10s) — nostr-tools waits for EVERY relay to EOSE, so one blackholed relay hangs an unbounded fetch forever.
- Relay fetch errors must be caught and logged inside the fetch function; the promise must resolve with the DB-seeded data, never reject on relay failure.
- `editShopContext` REPLACES the whole shop map (unlike `editProfileContext`, which merges). Never call it with `new Map()` as an error fallback — that blanks every shop logo. `editProductContext(null, ...)` preserves existing products.

**Why:** observed relay outages (damus refusing connections, nostr.band timeouts, purplepag.es 502) blanked avatars/logos even though profiles were DB-cached, because relay rejections propagated into callers that reset contexts with empty maps.

**How to apply:** any new cached-first fetch or error fallback in fetch-service.ts / \_app.tsx; regression tests live in `__tests__/utils/nostr/fetch-service-relay-resilience.test.ts`.
