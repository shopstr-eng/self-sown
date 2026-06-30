---
name: Product context client-side dedup
description: Why client mutations of the product context must dedup kind:30402 by NIP-33 identity, not append by event id
---

# Product context client-side dedup

Any code that mutates the in-memory product context (e.g. `addNewlyCreatedProductEvent`)
must upsert kind:30402 listings by their **NIP-33 replaceable identity** (`pubkey:d-tag`),
never append by `event.id`. The shared key + upsert helper is `utils/nostr/product-event-key.ts`
(`getProductEventKey` / `upsertProductEvent`); the same keying lives in the fetch paths.

**Why:** kind:30402 products are parameterized replaceable events — a republish (price/inventory
edit, applying a parcel template, live-shipping setup) keeps the same `d` tag but mints a NEW
event id. The initial fetch (`fetch-all-posts-abortable`, `fetch-service`) dedups by `pubkey:d`,
but the client append path did NOT, so an old + republished copy coexisted in
`productContext.productEvents`. On a custom stall, `StorefrontProductGrid` only pulls
`products[0]` out as the "featured" banner and renders the rest as cards — so the duplicate
showed as BOTH the featured banner AND a regular product card. The marketplace grid has the
same exposure (it also doesn't re-dedup the context).

**How to apply:** when adding/replacing a product event in any context setter, route it through
`upsertProductEvent` (keeps newest `created_at`, replaces in place to preserve the featured
`products[0]` slot). Keep the keying logic in the single shared helper — do not re-inline a
local `getEventKey` (there were already drifting copies in `fetch-service.ts`). If you ever see
a featured/hero product duplicated as a card, suspect a client mutation that appended by id.
