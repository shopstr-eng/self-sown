---
name: Stall subpage SSR validator contract
description: The /stall/<slug>/<sub> validator must mirror StorefrontLayout's render set exactly or routes 404 (or false-200) on every host
---

`pages/stall/[...stallPath].tsx` getServerSideProps rejects unknown subpages with a real 404. The allowlist must match what `components/storefront/storefront-layout.tsx` actually renders, or nav/footer/checkout links 404 on BOTH platform and custom-domain hosts (proxy rewrites custom domains into /stall/<slug><path>).

The contract, all shared via constants/resolvers so the two sides can't drift:
- Ungated built-ins: `STOREFRONT_BUILTIN_SUBPAGES` in utils/storefront-links.ts (shop, orders, blog, my-listings, order-confirmation).
- Flag-gated built-ins: `STOREFRONT_GATED_SUBPAGES` maps wallet/community to their `showWalletPage`/`showCommunityPage` storefront flags.
- Editor-reserved slugs: `RESERVED_PAGE_SLUGS` = built-ins + gated + `Object.values(POLICY_SLUGS)`; page-editor.tsx imports it — never keep a local copy.
- Policy slugs: `resolveStorefrontPolicy()` in utils/storefront-policies.ts is the ONE resolver for SSR, footer links, and the layout render branch (stored policy wins when present with truthy `enabled`; absent/null → enabled default).
- Custom pages live NESTED at `content.storefront.pages` and route by `p.slug` only. Matching top-level `c.pages` or `p.id` 404s every real page or accepts routes the client can't render.

**Why:** the validator launched with an incomplete set (missing shop/policies/pages-by-slug), which 404'd every policy page and custom nav page fleet-wide; a first fix then false-200'd non-Pro sellers because the client strips premium config via `basicStorefront()` (keeps only shopSlug/customDomain).

**How to apply:** adding any new storefront subpage surface means updating these shared constants, not the validator alone. SSR validates against `membership.isPro === true ? raw storefront : {}` — the same entitlement strip as the client — or persisted premium config false-200s for lapsed sellers.
