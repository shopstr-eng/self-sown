---
name: Section editor field parity (web vs mobile)
description: Per-type editable-field contract for the two storefront section editors; how new StorefrontSection fields are forced into both.
---

The web (`components/settings/storefront/section-editor.tsx`, hand-written JSX) and mobile
(`apps/mobile/lib/section-field-specs.ts`, spec-driven) section editors share one per-type
editable-field contract: `STOREFRONT_SECTION_EDITABLE_FIELDS` in `packages/domain/src/storefront.ts`.

- Adding a field to `StorefrontSection` is a **compile error** until the field is listed for at
  least one section type (conditional-type trick, same pattern as `ExhaustiveFieldList` for the
  email popup).
- `__tests__/mobile/section-field-specs-parity.test.ts` then fails until the mobile spec covers
  every listed key per type AND the web editor source references every listed key (source scan —
  the web editor has no importable field list, so per-type web coverage is NOT checked, only
  presence).
- The lists mirror the web editor's coverage (including its `LayoutStyleControls` per-type
  conditionals). Mobile deliberately may expose a superset (e.g. textAlign on hero) — the guard
  only requires mobile ⊇ contract, so a mobile-only field web lacks does NOT fail.

**Why:** before this, adding a `StorefrontSection` field updated neither editor and mobile
silently couldn't edit it (editor preserves unknown fields on save — capability gap, not data loss).
**How to apply:** when adding/renaming a section field, add it to the contract lists; expect the
parity test to name the missing editor. Nested record item fields (buttons, testimonials, …) are
NOT covered by the guard — top-level keys only.
