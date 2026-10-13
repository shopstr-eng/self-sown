---
name: Per-product page_config contract (web + mobile)
description: page_config tag on kind:30402 — domain owns build/validate/parse/tag helpers; both editors and both republish writers must go through them.
---

The per-product page design lives in the `page_config` tag (JSON
`StorefrontProductPageConfig`) on the kind:30402 listing event. Semantics are
owned by `packages/domain/src/product-page-config.ts`, not by either app:

- `PRODUCT_PAGE_CONFIG_FIELDS` — compile-checked exhaustive list; adding a
  `StorefrontProductPageConfig` field is a compile error until listed.
- `buildProductPageConfig` — null collapses to "remove the tag" (product
  inherits shop defaults); shop-defaults mode omits `sections`.
- `validateProductPageConfig` — hex colors, URL rule, 200/500 meta caps, 64KB
  serialized cap; gates BOTH save paths.
- `parseProductPageConfig` (last tag wins) and `withProductPageConfig`
  (strip + append) are the only allowed parse/serialize; both republish
  writers (web `republishProductWithPageConfig`, mobile
  `republishSellerListingPageConfig` in packages/nostr) use them plus the
  domain-owned `normalizeMarketplaceDiscoveryTag`.
- Guard: `__tests__/mobile/product-page-config-parity.test.ts` source-scans the
  web modal + mobile hub/store for every field key and the shared helpers.

**Why:** the user requires web↔mobile design parity that "can't drift"; the web
modal previously owned build/validate semantics privately, so a second editor
would have re-implemented (and silently drifted from) them.
**How to apply:** new page-config field → list it in the domain registry, wire
it into the web modal AND the mobile hub (app/(tabs)/listings/design/), keep
the shared helpers as the only gate. The mobile section editor is the shared
`SectionFieldsEditor` + controlled-mode `SectionListEditor` — extend those,
never fork them. Bulk-apply-to-other-products remains web-only by decision.
