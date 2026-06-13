---
name: Storefront product-as-landing reuse
description: When a storefront root serves a single product, reuse the listing view + shared OG helper rather than reimplementing.
---

# Storefront "product as landing page" — share, don't fork

Pro sellers can serve one product's page at their stall/custom-domain ROOT
(StorefrontConfig `landingPageMode: "product"` + `landingProductDTag`) instead
of the normal landing. The product is referenced by its replaceable `d` tag and
resolved only among events where `kind !== 1 && pubkey === shopPubkey && d === tag`.

## Rule

Any surface that renders a full product page (standalone listing page AND the
storefront root) must render the SAME `ProductListingView` component, and any
SSR/social OG meta for a product must come from the SAME `eventToProductOgMeta`
helper. Do not reimplement payment state, post-payment redirect, modals, JSON-LD,
or OG-meta logic in a second place.

**Why:** the standalone listing page and the storefront-root product render are
two entry points to the same experience. Two copies drift (one gets a checkout
fix or OG tweak the other misses). A user reported / we want the product page to
stay identical and fully customizable from either entry.

**How to apply:** new product-rendering entry point → import `ProductListingView`
(pass `topPaddingClass` to match that chrome's nav height) and, for SSR meta,
`eventToProductOgMeta`. Gating is render-layer fail-closed: `basicStorefront()`
strips the two fields for non-Pro/lapsed/unresolved entitlement, and the layout
only activates the branch when `proEntitled === true`. The MCP/settings write
paths may store the fields without an entitlement check — that's fine because the
serve layer enforces; never rely on the write path for the gate.
