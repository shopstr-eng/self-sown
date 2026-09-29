---
name: Storefront heading hierarchy (h1→h2→h3)
description: SEO/a11y scanners flag h1→h3 skips on stall pages; item-level h3s need a guaranteed preceding h2 that survives seller elementOrder
---

Storefront sections render item titles as h3 (product cards, blog posts, ingredient/timeline names, Shipping/Returns subheads). If the seller leaves the section heading blank — or saves an `elementOrder` that places content before the heading — those h3s land directly under the page h1 and SEO scanners flag "heading hierarchy skips H1 to H3".

**Rule:** any section whose content emits h3s must guarantee an h2 precedes them. Render an sr-only h2 fallback at the TOP OF THE CONTENT SLOT (never the heading slot), gated on `needsHiddenSectionHeading(section)` from `section-elements.tsx` (true when the heading is blank OR content is ordered before the heading). Heading-slot placement fails because `resolveSectionElements` honors the seller's elementOrder (`["content","heading"]` renders items first).

**Why:** a live stall was flagged by an SEO scan: hero h1 → 10 product-card h3s with zero h2 in the DOM. The skip had multiple independent paths: blank section headings, seller elementOrder reordering, email-popup/footer h3s on sparse pages, and the product-as-stall-root checkout card. Fixing one surface does not cover the others.

**How to apply:**

- New StorefrontSection types or storefront chrome emitting h2/h3: check the page outline can't skip levels on stall pages, custom-domain stalls, AND product-as-root views.
- Footer/popup brand or form headline text must not be a heading element — use `p`/`span` with the same classes (Tailwind preflight makes it visually identical).
