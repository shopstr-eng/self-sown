---
name: FX rate resilience — display vs charge paths
description: How buyer-facing FX price displays survive a brief rate-feed outage, and why the display path must NOT copy the charge path's fail-closed throw behavior.
---

The sats↔fiat exchange-rate feed (Alby `getFiatValue`/`getSatoshiValue`) is
flaky for moments at a time. Two distinct resilience strategies live in
`utils/stripe/currency.ts`, and they must stay distinct:

- **Charge math** (`satsToUSD`, server-side): retries + a short-lived last-good
  USD-per-sat cache, then **throws `ExchangeRateError`** (fail-closed) on
  persistent failure. A bad/missing rate must never reach Stripe/charge math.
- **Buyer-facing display** (`getSatoshiValueResilient` / `getFiatValueResilient`):
  same retry + bounded-freshness pattern, but **returns `null`** (never throws)
  on persistent failure so the invoice cards render a placeholder instead of a
  blank/broken price. Per-currency linear-rate cache (`displayRateCache`), reused
  only within `exchangeRateRetryConfig.cacheMaxAgeMs` so a stale rate is never
  shown.

**Why:** before this, the invoice cards called the Alby tools directly with no
retry/cache, so a single transient blip blanked or broke the displayed
converted price even when checkout itself would now survive the same blip.

**How to apply:**

- Use the `*Resilient` wrappers for any new buyer-facing FX display in
  `components/product-invoice-card.tsx` / `cart-invoice-card.tsx`. They return
  `number | null`; map `null` to the call site's existing fallback (raw amount,
  0, or a placeholder) — do not let `null` flow into arithmetic.
- Do NOT route the actual payment/charge amount computations (lightning invoice
  sats, the Stripe charge) through the display wrappers — those must stay
  fail-closed (throw / explicit error), because a cached-rate fallback there
  could silently mis-charge.
- Both wrappers and the config share `exchangeRateRetryConfig`; tests can shrink
  its timings and clear caches via `_resetExchangeRateCache` /
  `_resetDisplayRateCache`.

## Which card charge amount the display FX can actually reach (cart shape matters)

When reviewing whether a display-FX fallback can mis-charge, the answer depends
on the cart shape — do NOT assume "display feeds charge" globally:

- **Multi-merchant cart** (`sellerSplits` in `cart-invoice-card.tsx`
  `handleStripePayment`): each split's `amountSmallest` + `currency` are summed
  **purely in that seller's own native currency** (`sellerCurrency`, native line
  prices, native `getConsolidatedShippingForSeller`). **No cross-FX**, so the
  `nativeTotalCost` display total can never reach the charge here.
- **Single-seller cart / single product**: the charge IS the client-computed
  total (`stripeCosts.nativeTotal` in `cartCurrency`; product `discountedTotal`),
  and the server only does `toSmallestUnit` (no FX) for fiat. So display FX
  reaches the charge **only** for the exotic case of ONE seller with
  intra-seller mixed currencies (e.g. USD product + sats-denominated shipping)
  during a persistent FX outage → raw/`0` fallback flows into the charge
  (undercharge / omitted shipping).

**Why this matters:** an architect review will flag "display FX feeds Stripe
charge" as a blocking bug. It is real but **pre-existing** (origin/main already
fell back to raw/`0` on FX throw; the resilient wrappers only added retry+cache
in front of the SAME fallback and did not touch the charge-derivation code), so
it is NOT a regression for a branch that merely refactors the FX helpers.

**Now hardened (charge fail-closed on the single-seller path):** the single-seller
cart (`cart-invoice-card.tsx`) and single-product (`product-invoice-card.tsx`)
cards track a `chargeFxFailed` / `shippingFxFailed` flag and **throw
`ExchangeRateError` to block a CARD charge** when a charge-contributing
conversion fell back to raw/`0`. The buyer sees the retry message
(`EXCHANGE_RATE_BUYER_MESSAGE`) instead of being mis-charged. Multi-merchant
stays exempt (native per-seller `sellerSplits`, no cross-FX).

**The flag must be fail-closed across the async window, not just at steady state.**
Set it pessimistically `true` _synchronously_ right before the async conversion
runs, and clear it only when the conversion succeeds. A same-currency cart hits
no `await`, so React batches the pessimistic `true` with the immediate reset to
`false` (no false positive); a cross-currency cart keeps it `true` through the
await window so a fast card submit during a just-started outage can't slip a
stale/unconfirmed total through. A purely steady-state flag (set only after the
effect resolves) leaves a race where the guard reads a stale "safe" value.

**Crypto charge is always fail-closed** regardless of cart shape: the server
converts sats→USD via `satsToUSD` (throws `ExchangeRateError`), so a bad rate
can never silently mis-charge a Bitcoin-denominated item paid by card.

## Combined-cart shipping parity (sats vs fiat) is a real charge change, but a FIX

The combined-cart shipping fixes make the sats `recompute` effect and the fiat
`nativeTotalCost` effect charge shipping over the **same** seller/product set:
both skip pickup products via the per-product combined gate (checked before the
seller is marked seen), both skip free-shipping-qualifying sellers (a per-seller
property, so guard ordering can't diverge), and both use the identical
`sellerProducts` filter. This changes the card total for combined carts that mix
pickup + shipped items (it stops over-charging shipping on pickup items) — a
**correctness fix that aligns card with Bitcoin totals**, not a regression.
