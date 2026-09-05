---
name: Spec shipping options (kind 30406)
description: design decisions for the GammaMarkets market-spec shipping-option implementation — dual-write fallback, cost seam, destination eligibility policy
---

# Spec shipping options (kind 30406)

The GammaMarkets market-spec shipping options (kind-30406 events + `shipping_option` refs on kind-30402) are implemented as an OVERLAY, not a replacement:

- **Dual-write**: the product form still writes the legacy `shipping` tag AND publishes one 30406 per method + ref tags. The legacy tag remains the summary/fallback and is the ONLY shipping source the cart (cart-invoice-card) understands.
- **Why:** legacy clients and the cart have no 30406 awareness; removing the legacy tag would strand them. A selected spec option wins over BOTH the legacy static cost and live USPS quotes in the single-product card (spec: product configuration is the source of truth).
- **Cost seam**: `effectiveShippingCost`/`effectiveShippingCurrency` in product-invoice-card.tsx is the single seam feeding the FX-conversion effect → convertedShippingCost → all totals/rails. Any new shipping source must enter there, not downstream.
- **Destination policy**: `country` (required by spec) is enforced hard — `isSpecDestinationBlocked` blocks checkout before every rail when options exist but none serves the buyer's mappable country (never fall back to legacy, or the restriction is theatre). region/weight/dim constraints are deliberately advisory (seller confirms at fulfillment). Unmappable/blank buyer country = cannot-evaluate = NOT blocked. Buyer forms store country NAMES ("United States of America") — map via toCountryCode.
- **Edit safety**: product-form hydration preserves refs whose option events failed to load (relay outage ≠ deliberate removal) and blocks submit while hydration is pending.
- **Deliberate gaps (follow-ups)**: cart option picking, 30405 collection-ref resolution, 30406 DB persistence, order-DM carrying the chosen method (only orderSummary carries it), MCP tooling.
