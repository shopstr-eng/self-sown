---
name: Adding a StorefrontSectionType
description: All surfaces a new storefront section type must touch; which are compiler-enforced vs silently fail.
---

Adding a value to `StorefrontSectionType` (packages/domain/src/storefront.ts) ripples
across many surfaces. The compiler catches some; others fail silently.

**Compiler-enforced (TS errors if missed):**

- `STOREFRONT_SECTION_TYPES` set + inline union casts in `packages/domain/src/seller.ts`.
- `SECTION_LABELS: Record<StorefrontSectionType, string>` in `components/settings/storefront/section-editor.tsx`.

**NOT enforced — fail silently, must grep:**

- `SectionPreviewSvg` switch in `components/settings/shop-profile-form.tsx` has a
  `default: return null`, so a new type renders a BLANK editor preview with no error.
- Both sanitizer allowlists (homepage `sections[]` and `pages[].sections[]`) in seller.ts:
  any new configurable field (e.g. `successMessage`, `ctaText`, `headingColor`) must be
  added to the right allowlist or it's stripped on normalize (one is full-field, one is
  a short id/type/heading/body subset). See `storefront-section-dual-sanitizer.md`.
- `section-renderer.tsx` needs a `case`, or the section just doesn't render on the stall.
- Option lists + filters in `page-editor.tsx` and `shop-profile-form.tsx` (the "add section"
  menus) — a type omitted here can't be added by the seller.
- Body-text allowlist in `section-editor.tsx` if the type has an editable body.
- `SECTION_PLACEHOLDERS` in `components/settings/storefront/storefront-preview-panel.tsx`:
  a type with no entry previews BLANK the moment it's added (before the seller fills any
  field). Add a placeholder entry (reuse the file's `PLACEHOLDER_*` image consts) so the
  add-to-preview isn't empty.

**How to apply:** when adding a section type, grep for an existing type name (e.g. "reviews")
across the repo and mirror every hit; lean on the compiler for the two enforced maps but
manually verify the silent ones (preview SVG default-null + sanitizer allowlists).
