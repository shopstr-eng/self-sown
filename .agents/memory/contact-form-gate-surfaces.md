---
name: Contact-form endpoint gate surfaces
description: Every place a contact_form section can live must be checked by BOTH public endpoints (contact-form + subscribe) or sellers using that surface get silent 403s.
---

The public visitor endpoints `/api/storefront/contact-form` and `/api/storefront/subscribe` are anti-spam gated: they 403 unless the seller actually publishes an enabled `contact_form` section somewhere. A contact_form can now live in FOUR surfaces, and both endpoints must check all of them:

1. Homepage `storefront.sections`
2. Custom builder pages `storefront.pages[].sections`
3. Product-page template defaults `storefront.productPageDefaults`
4. Per-product `page_config` tags on kind:30402 events (fallback scan via `sellerHasProductPageContactForm`, fail-closed)

**Why:** when product pages gained contact_form support, sellers who ONLY placed the form on a product page were 403'd by both endpoints — hidden breakage because the form renders fine but submission fails.

**How to apply:** adding any new surface where sections can be published (new page kind, new config field) means updating both endpoint gates. Semantics differ: subscribe requires `contactFormMode === "subscription"`; contact-form accepts any enabled form. The gate is spoof-proof because both inputs are seller-signed Nostr events (cache-event verifies signatures).

Related trap: `normalizeStorefrontConfig`'s `sanitizeFullSection` downgrades unknown/product\_\* section types to `"text"` — it must NOT be applied to `productPageDefaults` (pass through with isRecord filter only). Before the passthrough existed, the parse→build round-trip (used by MCP set_shop_profile) silently ERASED productPageDefaults entirely.
