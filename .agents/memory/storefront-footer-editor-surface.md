---
name: Storefront footer is its own editor surface
description: Footer customization (newsletter, layout) lives in a SEPARATE editor from sections; parity edits must be wired there too.
---

The storefront **footer** is configured by `components/settings/storefront/footer-editor.tsx`
— a distinct component from the section editor. Adding a footer capability (e.g. a newsletter
block, or footer `layout` parity with the navbar: alignment / linkSpacing / columnLayout)
means wiring FOUR surfaces, and the seller-facing editor is the one most easily forgotten:

- domain types in `packages/domain/src/storefront.ts` (`StorefrontFooter` + sub-interfaces),
- domain normalizer in `packages/domain/src/seller.ts` (validate/allowlist the new footer._ fields;
  enums checked against the shared `STOREFRONT*NAV_LINK*_`/`STOREFRONT*FOOTER*\*` sets),
- renderer in `components/storefront/storefront-footer.tsx` (+ any child like the newsletter component),
- **`footer-editor.tsx`** — the human seller UI. Missing this means the feature is only reachable
  via the MCP API; the settings page can't configure it at all.

**Why:** in the banner_carousel + footer-newsletter task, everything else was done but the
footer-editor block was skipped, and code review (architect) returned FAIL solely on that gap —
"footer as customizable as the navbar" was unmet for the primary human surface.

**How to apply:** field names in footer-editor's `onChange({...footer, newsletter:{...}})` /
`footer.layout` writes must byte-match the normalizer + MCP zod schema, or the normalizer strips
them. Reuse the file's `inputWrapperClass` / `selectClassNames` and default Selects to the
RENDERER's defaults (columnLayout `spread`, linkSpacing `normal`) so the UI reflects real behavior.
`shop-profile-form.tsx` already passes `footer`/`setFooter` into FooterEditor — no extra plumbing.
