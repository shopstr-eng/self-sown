---
name: StorefrontConfig key parity (web vs mobile)
description: Config-level (non-section) design settings contract — key partition registry, editor source-scan guard, and maximal round-trip fixture.
---

Sibling of [section-editor-field-parity](section-editor-field-parity.md) for the
config-level (non-section) `StorefrontConfig` keys.

- `packages/domain/src/storefront.ts` ends with a compile-checked partition:
  `STOREFRONT_CONFIG_DESIGN_KEYS` + `STOREFRONT_CONFIG_NON_DESIGN_KEYS` must cover
  `keyof StorefrontConfig` exactly once (`StorefrontConfigKeyPartitionIsExact`).
  Adding a config key is a compile error until it's placed in one list.
- `__tests__/mobile/storefront-config-parity.test.ts` then fails until BOTH the web
  settings (shop-profile-form.tsx + product-page-template-form.tsx + storefront/*)
  and the mobile design screens reference every design key (word-boundary source
  scan, same pattern as the web section-editor check — presence only).
- Carry-over: `packages/domain/src/__tests__/storefront-config-roundtrip.test.ts`
  has a `Required<StorefrontConfig>` maximal fixture through
  parseSellerShopProfileEvent — adding a key without a fixture value is a compile
  error; a normalizer drop fails toMatchObject. Fixture values must survive
  documented normalizer semantics (hideShopLink persists only as true,
  acceptBitcoin only as false, acceptsEscrow only as true, non-empty collections,
  pre-sanitized https URLs).

**Why:** the user required full web↔mobile design-settings parity that "can't
drift"; before this, `assistantVisibility` was web-only and several config fields
were silently dropped by the normalizer on mobile republish.
**How to apply:** a new StorefrontConfig key = compile error in storefront.ts;
choose design (both editors must reference it, parity test enforces) vs
non-design (round-trip only). Non-design today: shopSlug (basics form),
customDomain (DB-backed verification is authoritative — the event field is legacy,
no current writer sets it, parse preserves it for republish), paymentMethodOrder /
acceptBitcoin / acceptsEscrow (web payment settings only). Per-product pageConfig
overrides (customize-product-page-modal.tsx, stored on product events) remain
web-only by decision; mobile preserves them via partial-edit tag preservation.
