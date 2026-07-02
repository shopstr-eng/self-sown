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
