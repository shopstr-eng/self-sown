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
