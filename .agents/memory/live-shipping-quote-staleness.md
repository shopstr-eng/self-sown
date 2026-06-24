---
name: Live shipping quote staleness
description: Why live USPS/Shippo rate quotes in checkout must be input-keyed and validated at the consumption site, and how the convertedShippingCost FX lag is (and isn't) a money risk.
---

# Live shipping quote staleness (cart + single-product checkout)

A live Shippo rate quote is only valid for the EXACT inputs it was fetched for
(seller pubkey, origin zip, destination line1/city/state/postal, parcel
weight×bulk + dims). The quote is fetched on a ~700ms debounce, so during the
debounce + network window the buyer can have already changed the destination.

**Rule:** tag each stored quote with a `key` = JSON of those inputs, recompute
the current key during render, and only treat a quote as active when
`quote.key === currentKey`. Validate at the CONSUMPTION site
(`effectiveShippingCost`), not merely by clearing state on ineligible
transitions — clearing alone leaves a stale quote chargeable until the new
fetch resolves.

**Why:** without key validation, a quote fetched for address A stays applied to
the total/charge/order-summary during the debounce/fetch window for address B —
a money-safety race (buyer charged A's rate for B's shipment). Keying makes the
stale quote inactive the INSTANT any input changes, before the new fetch even
starts.

**How to apply:** make the live-rate effect depend only on `[quoteKey]` with a
single `!quoteKey` bail path that clears BOTH the quote and the in-flight
spinner flag (an in-flight fetch cancelled by an ineligible transition won't run
its `finally`, so reset the spinner in the bail path or it sticks). Store
`key: quoteKey` on success.

## convertedShippingCost FX lag — when it is/ isn't a charge risk

Totals/handlers consume `convertedShippingCost`, which an async FX `useEffect`
derives from `effectiveShippingCost`/`effectiveShippingCurrency`. Two facts keep
this safe without re-architecting:

- **Same-currency (shipCur === productCur, the common live-quote case since live
  quotes are USD):** the FX effect sets `convertedShippingCost` SYNCHRONOUSLY
  (no await). React flushes that passive effect before the next discrete click,
  so by click time it already reflects the static fallback. Provable in RTL: a
  test can assert the total reverted right after `fireEvent.change` with NO
  `waitFor` (fireEvent flushes effects via act()).
- **Cross-currency:** the effect sets `shippingFxFailed = true` FIRST, which
  fail-closes the CARD charge until FX resolves. The residual sub-second lag on
  LN/Cashu for a sats product is a property of the SHARED async-FX design,
  inherited verbatim from `cart-invoice-card.tsx`.

**Why not "fix" the lag per-card:** `product-invoice-card.tsx` mirrors
`cart-invoice-card.tsx` (the source of truth). Making converted-cost key-aware
in only one card would diverge them; the FX architecture is shared and any real
change belongs in both, deliberately, not as a port side-effect.
