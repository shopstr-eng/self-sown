---
name: GEO shipping destination from currency
description: Why product JSON-LD derives a shippingDestination from shipping currency, and the no-fabrication rule.
---

# GEO shipping destination

Google's product rich results only render the shipping cost when
`OfferShippingDetails` also carries a `shippingDestination` (DefinedRegion);
a shippingRate alone is silently ignored.

**Rule:** the destination is derived ONLY from a _valid shipping tag's own
currency_ (single-country currencies map to one ISO 3166-1 country). Never the
product price-currency fallback, and only when a concrete fiat shipping cost
exists. The `"N/A"` shipping type is an allowed value but means "no shipping
config", so it is explicitly excluded even though it carries a currency.

**Why:** the shipping tag's currency is the only structured destination signal a
NIP-99 listing carries — there is no per-product "ships-to country" field.
Deriving from the price currency, or from the `"N/A"` default shipping type
(whose effective cost is 0), would invent a region for listings with no real
shipping config. Ambiguous/multi-country currencies (EUR) and bitcoin/sats are
omitted too. The whole point is "omit when unknown, never fabricate" — matching
the JSON-LD builder's fiat-only, no-fabrication stance.

**How to apply:** if a real "ships to" field is ever added to listings/seller
config, prefer it over the currency proxy. Keep omitting the region when unknown
rather than guessing. Free/pickup $0 rates with a valid tag still count; no tag,
null/unquotable cost, or a bare fiat price does not.
