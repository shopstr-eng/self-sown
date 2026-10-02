---
name: Stall SSR content contract
description: The pre-hydration block on stall pages is the crawler-facing content contract — agentic-readiness scanners require >=500 chars of meaningful text and JSON-LD pricing.
---

The `!shopDataReady` block in components/storefront/storefront-layout.tsx is NOT a loading placeholder — it is the only content AI crawlers/scanners see in raw HTML (the client app hydrates over it). It must keep: a single H1 (shop name), the about text, and the products section (H2 + list items with names/prices/links via the `ssrProducts` prop) — headings strictly sequential, item names as list text not headings.

**Why:** An agentic-readiness scanner flagged custom stall routes with "123 chars of text" and "no pricing data". Scanners want ~500+ chars of meaningful homepage text and schema.org pricing (Offer with price/priceCurrency/availability, or AggregateOffer for variant price ranges) without executing JS. Padding with boilerplate to hit 500 is NOT acceptable — tiny stalls stay thin rather than fabricate content.

**How to apply:** Never strip or lazy-load that block as "dead code"; extend it with truthful product-event data only. JSON-LD pricing flows through buildProductOfferJsonLd (utils/geo/product-jsonld.ts) shared by buildProductJsonLd (product pages) and buildItemListJsonLd (stall homepage, Products nested inside ListItems — never top-level, the no-duplicate guard test enforces it). Fiat-only prices; XBT offers stay priceless by policy. Custom domains get the same content for free via the proxy rewrite to /stall/<slug> — thread origin-sensitive URLs through the x-ss-custom-domain-host headers, not new code paths.
