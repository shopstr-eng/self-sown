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
  conditionals), and the guard requires the mobile spec to match each type's list EXACTLY
  (both directions) — a mobile-only field fails just like a missing one. Rule of thumb for
  which types get a style field: only where the storefront renderer actually honors it
  (e.g. textAlign is read by the text/about renderers only, so it stays off all other types'
  lists and out of the shared mobile STYLE_FIELDS group).

Field-name parity is not enough — the mobile spec controls can also write the wrong UNITS or
TYPES for the web renderers/domain parser. Known conversions live on the spec entries
(`fromStore`/`toStore`, applied by `design/section/[id].tsx`) and are round-trip-tested in
`__tests__/mobile/section-field-value-roundtrip.test.ts`:
- `overlayOpacity` stores a 0–1 fraction; the control edits 0–100 (like the web slider).
- `bannerInterval` stores MILLISECONDS (carousel setInterval floor 1500ms); the control edits seconds.
- `imageWidth` stores an allowlisted NUMBER; chips are string-valued, so convert both ways.

**Why:** before this, adding a `StorefrontSection` field updated neither editor and mobile
silently couldn't edit it (editor preserves unknown fields on save — capability gap, not data
loss); later, mobile offered a superset web couldn't show, and unit-mismatched mobile edits
(percent opacity, second intervals, string widths) were silently dropped or misrendered on web.
**How to apply:** when adding/renaming a section field, add it to the contract lists; expect the
parity test to name the missing editor. A style field belongs only on types whose renderer reads
it. If a new control's stored unit/type differs from what it displays, add `fromStore`/`toStore`
to the spec and extend the round-trip test. Nested record item fields (buttons, testimonials, …)
have their own guard (`STOREFRONT_SECTION_ITEM_FIELDS` + per-editor source slices in the parity
test).
