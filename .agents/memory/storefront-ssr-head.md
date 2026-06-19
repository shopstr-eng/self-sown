---
name: Storefront SSR head tags (favicon + OG)
description: Why storefront favicon/OG meta must flow through getServerSideProps ogMeta, not client-side shop data.
---

# Storefront favicon + OG must be SSR, not client-only

For custom stalls (`/stall/<slug>`, `/stall/<...stallPath>`) and custom domains (proxy rewrites the apex/subdomain to `/stall/<slug>`), any head tag a seller wants discovered by search engines or social-preview bots must be produced in `getServerSideProps` and passed via `pageProps.ogMeta` → `DynamicHead`.

**Why:** crawlers/social bots only read the initial server HTML; they do not run the client-side Nostr/shop fetches. The favicon used to be derived only from client-side `shopEvents.get(pubkey).content.ui.picture`, so bots never saw the seller's icon — only the default Milk Market one.

**How to apply:** the seller logo (`content.ui.picture || content.ui.banner`) goes into `ogMeta.favicon` at SSR. `DynamicHead` prefers `ssrOgMeta.favicon`, then falls back to the client custom-domain logo (for rewritten routes like `/listing`/`/cart` that have no SSR ogMeta), then the platform default. Same principle for `og:site_name`, `og:type`, `og:locale`, keywords, geo tags — read them from `ssrOgMeta` with platform defaults as fallback.

# JSON-LD structured data: SSR it, and grep for a pre-existing client copy first

Product/Offer/ItemList JSON-LD for GEO (crawlers + AI shopping agents) must be SSR'd the same way — built in `getServerSideProps` and carried on `ogMeta.jsonLd` (array of objects) → rendered by `DynamicHead` as `<script type="application/ld+json">` through `safeJsonLdString` (escapes `<`/`>`/`&`/`U+2028/2029` so the page can't be XSS'd via listing content).

**Why:** before wiring SSR JSON-LD, the listing view component (`components/listing/product-listing-view.tsx`) already rendered its OWN hand-rolled Product JSON-LD client-side via `<Head>`. Adding the SSR one produced **two** Product nodes per page (duplicate structured data) and two divergent builders to keep in sync. You only catch this by viewing the rendered HTML, not by reading either file alone.

**How to apply:** when adding SSR structured data, grep the page's rendered components for an existing `<Head>` / `application/ld+json` / `buildProductJsonLd` and remove the client copy so there's ONE node and ONE builder. Derive all JSON-LD from the canonical `UcpProduct` mapper (`utils/ucp/catalog.ts` → `utils/geo/product-jsonld.ts`) so MCP/UCP/GEO can't drift. Stay conservative: fiat-only Offer `price`/`priceCurrency` (Google rejects the `XBT` bitcoin code and we never FX sats↔fiat), and never fabricate `aggregateRating`/`review`/`hasMerchantReturnPolicy`/hours. Known acceptable drift: `Product.url` uses the UCP default `/listing/{dTag|id}` (which 301s to the friendly slug) rather than the exact canonical page URL; the `<link rel=canonical>` still carries the correct slug.
