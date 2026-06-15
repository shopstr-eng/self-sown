---
name: Storefront section dual sanitizer + shared editor
description: Why a new StorefrontSection field can render on the homepage hero but silently vanish on a custom page.
---

# StorefrontSection has two sanitizers, and the editor is shared

`normalizeStorefrontConfig` (packages/domain/src/seller.ts) sanitizes section
data in **two separate places**:

- **Top-level `sections[]`** — the homepage builder. Carries the full set of
  hero fields (heading, subheading, image, overlayOpacity, headingColor,
  subheadingColor, textOutlineColor, items, etc.).
- **`pages[].sections[]`** — custom builder pages. Deliberately preserves only a
  minimal subset (id/type/heading/body). Most hero-specific fields — including
  `image`, `subheading`, `overlayOpacity`, and the color/outline fields — are
  **stripped on save/reload** here.

`SectionEditor` (components/settings/storefront/section-editor.tsx) is the SAME
component used by both the homepage section editor and `PageEditor`. So a field
you add to the editor's hero block is editable on a custom page but gets dropped
the next time the page config round-trips through the pages sanitizer.

**Why:** the two sanitizers were intentionally scoped differently — custom
pages were never meant to carry full hero styling. Adding a field to the
top-level sanitizer is enough for the homepage/custom-stall hero banner.

**How to apply:** when adding a new `StorefrontSection` field, the top-level
`sections[]` sanitizer + MCP zod schema + renderer is sufficient for the
homepage hero. Only touch the `pages[].sections[]` sanitizer if you explicitly
intend the field to survive on custom builder pages — and if so, you'll likely
need to also carry the other already-stripped hero fields for consistency.
