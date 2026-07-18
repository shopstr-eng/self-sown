---
name: Section element layout fields threading
description: Where per-section layout fields (elementOrder/imagePlacement/sizes/buttons) must be wired, and how the legacy byte-identical constraint is kept.
---

Per-section layout fields (`elementOrder`, `imagePlacement`, `headingSize`, `bodySize`, `imageWidth`, `buttons[]`) are a multi-surface contract:

- **Domain**: one shared `sanitizeSectionLayoutFields` wired into BOTH sanitizers (full homepage/blogPage sanitizer AND the reduced `pages[].sections` allowlist). `productPageDefaults` and per-product `page_config` are intentional passthroughs — no sanitizer runs there.
- **Renderers**: all ~21 section renderers delegate to `SectionElementFlow` (`components/storefront/sections/section-elements.tsx`). Because the pageConfig path is unsanitized, safety must live at render time: `resolveSectionElements` dedups/filters unknown tokens, button hrefs go through `sanitizeStorefrontSectionLink`, background image through `sanitizeUrl`.
- **Legacy byte-identical rule**: when none of the fields are set, the flow renders slots in default order inside plain Fragments (no wrapper DOM) and size helpers take a fallback class param that reproduces exact legacy class strings. Hero/about keep a bespoke legacy path gated by `hasStructuralLayout()`.
- **Editor**: the Arrange UI lives once in `LayoutStyleControls` inside the shared `SectionEditor`, which automatically covers homepage, custom pages, blog page, and product-page editors.
- **MCP**: `set_shop_profile` zod schemas strip unknown keys, so every new section field must be added to BOTH `pageConfigSectionSchema` and the `storefrontSections` schema in `mcp/tools/write-tools.ts`; the handler assigns sections wholesale (non-lossy). `storefrontPages` sections are `z.any()` (no change needed).

**Why:** missing any surface fails silently — fields vanish on save (sanitizer), on agent writes (zod stripping), or render unsafely (pageConfig path has no sanitizer).

**How to apply:** any new per-section field ⇒ touch shared sanitizer + both MCP schemas + SectionElementFlow (with a legacy fallback), and grep `STOREFRONT_SECTION_ELEMENTS` if it's a new element token.

**Contrast rules (verified live):** text over a background-placed image must contrast with the OVERLAY color, not the theme background — the flow overrides `color` + `--sf-text` (headings read the var) on the overlay content wrapper via a luminance pick. Button labels/outline accents run through `buttonLabelColor` (theme color kept only if its luminance differs ≥0.3 from the surface); background-placement passes the overlay color as the outline `surface`. Live-verify caveat: full-page puppeteer screenshots of the stall page can capture a pre-hydration frame with stale colors — trust element-level screenshots/computed styles.
