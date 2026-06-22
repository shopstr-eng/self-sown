---
name: Listing-tag URL sanitization
description: Any URL pulled from a permissionless Nostr listing/product tag and rendered to buyers must be scheme-validated at parse and sanitized at render.
---

# Untrusted URLs in product/listing tags

Product listings (kind:30402) are permissionless: anyone can hand-craft the
Nostr event outside the seller form, so any tag value is attacker-controlled.

**Rule:** when you add a new product/listing tag whose value is a URL that ends
up in buyer-facing `href`/`src`, defend it in TWO layers:

1. **At parse** (`utils/parsers/product-parser-functions.ts`): trim and accept
   only `http://` / `https://`; drop anything else (`javascript:`, `data:`,
   relative). This keeps the parsed `ProductData` clean so downstream UI never
   sees a hostile value.
2. **At render** (component): still pass it through `sanitizeUrl` from
   `@braintree/sanitize-url` as defense-in-depth (the codebase's standard — used
   for all storefront images/banners).

**Why:** the seller form only ever produces Blossom/CDN https URLs, so it's easy
to forget the buyer display must NOT trust the tag. A `javascript:` URL in an
`href` is a stored-XSS vector. This was caught in architect review of the
lab-report (COA) feature, not by tests.

**How to apply:** triggers whenever a buyer-rendered link/image is sourced from
a listing tag (lab reports, future attachments, external links, etc.). Pure
display metadata only needs parser + form + checkout-card display wiring (unlike
order line specs which thread through ~10 surfaces).
