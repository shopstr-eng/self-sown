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
  reduced subset (id/type/heading/subheading/body/ctaText/headingColor plus the
  contact-form fields and the FULL blog field set:
  blogLayout/blogPostIds/blogPostLimit/blogPostMode). Most hero-specific fields —
  including `image`, `overlayOpacity`, and the outline/color extras — are
  **stripped on save/reload** here. Exception: the six layout/style fields
  (backgroundColor/textColor/textAlign/contentWidth/imageHeight/imageFit) ARE
  now carried by BOTH sanitizers, because LayoutStyleControls in the shared
  editor exposes them on every section type. Enum values come from the
  `STOREFRONT_*` Sets near the top of seller.ts — check them before assuming
  (imageHeight is auto/short/medium/tall, NOT small/large).

MCP `set_shop_profile` now uses one shared `storefrontSectionSchema` (zod) for
BOTH `storefrontSections` and `storefrontPages[].sections` (was `z.any()`), so
unknown keys are stripped at the tool boundary too; the write path stores what
the schema passes, and fidelity is ultimately decided by the sanitizers above.

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

## The full sanitizer is now shared (`sanitizeFullSection`)

The homepage `sections[]` sanitizer was extracted into a named helper
`sanitizeFullSection` and is now reused by a THIRD sections container:
`blogPage.sections[]` (the built-in Blog index page). So there are three
containers with two fidelity levels: `sections[]` and `blogPage.sections[]` use
the FULL set (`sanitizeFullSection`); `pages[].sections[]` stays reduced.

**Rule for a new built-in toggleable page** (Blog mirrors Community/Wallet): its
dedicated `xPage.sections[]` must run through `sanitizeFullSection`, NOT the
reduced custom-pages sanitizer, or rich section fields silently vanish on
save/reload. Adding such a page also touches: `showXPage` config flag (kept in
`normalizeStorefrontConfig`), the reserved-slug set in `page-editor.tsx` (so no
custom page can claim that slug), the nav-link push + `activeSections` branch +
"Page Not Found" gate in `storefront-layout.tsx`, the index-vs-single route
split in `pages/stall/[...stallPath].tsx`, and MCP `set_shop_profile` parity for
the `showXPage` flag.
