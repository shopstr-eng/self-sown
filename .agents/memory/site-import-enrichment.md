---
name: Website-import (/convert) design pipeline constraints
description: Cross-file rules for enriching the URL-to-storefront import so extra sections render authentically and don't break the AI security boundary.
---

# /convert + Pro import (site-design) pipeline

Pipeline: `extractSiteSignals` (signals) → `buildExtractionDraft(signals)` (deterministic, fail-closed fallback) → `composeStoreDesignWithAI(signals, draft)` (AI enhance). Public endpoint `preview-from-url.ts` and authed Pro `import-from-url.ts` BOTH share `buildExtractionDraft`, so enriching the builder enriches both (desirable — the paid import should be ≥ the public teaser).

## Rules when adding richer imported content (images / text blocks)

- **AI never emits URLs/images — hard security boundary.** `composeStoreDesignWithAI` only composes palette/fonts + hero/about COPY; images/links come ONLY from deterministic extraction. So any new image/text sections MUST be built in `buildExtractionDraft`, never asked of the LLM. Do not add scraped image URLs (or body copy) into `buildPrompt` — keep the prompt-injection surface minimal.
- **`applyCopyToSections` rewrites ONLY `hero` and `about` types** (passes every other type through unchanged). Consequence: there can be at most ONE `about` section — a second `about` gets clobbered with the same AI copy. For extra image+text, use `text` (text-only) + `image` (standalone banner) types; `story`/`text` renderers do NOT render a top-level `section.image` (only `about` does, via imagePosition).
- **Preview `fillSectionPlaceholders` (storefront-preview-panel.tsx) fills EMPTY fields with fake farm content** ("Our cows grazing…", timeline years, etc.) — preview-only, but /convert IS a preview. So deterministically-built sections must carry REAL heading+body (text) and image+caption (image); e.g. give `image` sections a caption fallback chain (alt → siteName/title → hostname) so the fake pasture caption can never appear.
- **`rehostStorefrontDesignImages` already rehosts every `section.image` generically** (plus logo/banner/ogImage) on claim — new image sections need no rehost wiring.
- `ExtractedSiteSignals` is constructed ONLY in the extractor (ai-compose consumes it) — safe to add required fields without breaking other call sites/tests (no tests reference it).

**Why:** the whole value of /convert is an outreach preview that looks like the prospect's real site; fabricated placeholder copy/captions or an AI-clobbered duplicate section undermine that, and letting the LLM touch URLs would reopen an injection vector the pipeline deliberately closed.

## Preview fidelity: JSON-LD product cards + nav layout (preview-only)

- **Scraped product cards are PREVIEW-ONLY and must never be persisted.** `extractJsonLdProducts` (deterministic; schema.org Product/ItemList only; depth-bounded walk of `@graph`/`itemListElement`/`item`/`mainEntity`; capped; dedup by title) → `signals.products` → `sampleProducts` **TOP-LEVEL on `ImportedStoreDesign`** (NOT inside `storefront`), mapped to the preview's `ProductData[]` by `sampleProductsToPreview` (synthetic ids/pubkey, placeholder-image fallback; empty → `MOCK_PRODUCTS`). It sits deliberately outside the saved `StorefrontConfig` shape; nothing writes it to a config and `normalizeStorefrontConfig` would strip it anyway. Never move it into the storefront draft, and don't let the LLM see it (same URL-injection boundary as above).
- **The byte-identical-default guarantee rides on JSON.stringify omitting `undefined`.** `buildExtractionDraft` leaves `sampleProducts`/`storefront.navLayout` `undefined` when nothing was detected, so the serialized draft is unchanged for the common case (site has og:image, no JSON-LD, no centered-nav hint). `composeStoreDesignWithAI` spreads `...baseDraft` + `...baseDraft.storefront`, so both pass through the AI merge untouched — no re-apply needed in the preview/import API routes.
- **`detectNavLayout` is intentionally minimal:** only a CENTERED logo from explicit class hints in the FIRST header/nav block; anything else → `undefined` (= historical left default). Never emits above/below (needs layout metrics static HTML can't give). Keep the hint regex anchored to logo/nav/header/menu tokens — bare utility classes (`justify-center`, `mx-auto`, Bulma `is-centered`) false-positive and silently re-align real sites' navs.
- **navLayout has THREE load paths in shop-profile-form** (see shop-profile-form-load-paths.md): fast-DB + slow-relay read a saved `StorefrontConfig.navLayout`; the IMPORT-DRAFT path reads `ImportedStorefrontDraft.navLayout` and is distinct — an import-only storefront field must be re-applied there too or it vanishes from the imported preview→form handoff.
- **Hero banner fallback:** `buildExtractionDraft` uses `ogImage || first content image` for the hero banner (and shifts the about/extra image cursor by one when the first content image is consumed as the banner) — byte-identical whenever og:image exists.
