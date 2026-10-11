---
name: Storefront config normalizer completeness
description: normalizeStorefrontConfig must carry every StorefrontConfig field — any field it drops is silently deleted by save paths that round-trip through the parsed profile.
---

`normalizeStorefrontConfig` (packages/domain/src/seller.ts) is the single parse bottleneck for kind:30019 storefront configs. Any `StorefrontConfig` field it doesn't explicitly copy is **silently deleted** by every save path that rebuilds content from the parsed profile — the mobile design store, the mobile stall-basics editor, and any future API/MCP save.

**Why:** Until 2026-10 the normalizer dropped `navColors`, `footerColors`, `seoMeta`, `emailPopup`, `neoShadows`, `hideShopLink`, `customFont*`, and `assistantVisibility`. The web form survived because it re-derives those from its own form state; any normalized-round-trip consumer (e.g. the shipped mobile basics save) stripped them on every save. Found while building the mobile design editors.

**How to apply:** When adding a field to `StorefrontConfig`, add it to the normalizer in the same change AND extend the fixture in `packages/domain/src/__tests__/storefront-config-roundtrip.test.ts` — that test is the guard. Optional/absent fields must stay absent when unset (events are byte-stable; see the acceptBitcoin pattern). Related: [Storefront email-popup field threading](storefront-email-popup-fields.md), [Adding a StorefrontSectionType](adding-storefront-section-type.md).
