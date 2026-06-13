---
name: Sales tax is a card-only add-on line
description: Stripe sales tax must be treated as a Stripe-path-only extra at every checkout/order surface, never folded into the generic order total.
---

Opt-in US sales tax (Stripe Tax) is charged **only on the single-seller Stripe (card) payment path**. Lightning, Cashu, and manual-fiat payments never go through Stripe, so they are never taxed.

**The rule:** tax is its own separate line everywhere — never folded into the displayed/reported order total, and never added to non-card amounts.

- **Why:** displayed order totals follow the reported-vs-charged convention (items + discounted shipping, display-only); tax is a real extra charge that only the Stripe PaymentIntent applies server-side. Folding it in would misreport non-card orders and double-count.
- **How to apply (the surfaces that must stay consistent):**
  - **Checkout buttons:** only the "Pay with Card" amount includes `salesTaxNative`. LN/Cashu/manual-fiat button amounts stay tax-free. (Both `cart-invoice-card.tsx` and `product-invoice-card.tsx`, each with its own card-cost formatter.)
  - **Order summary:** the tax line is labeled "Sales tax (card payments)" so buyers understand why non-card buttons show less than the summary total. Each card has TWO summary blocks — update both.
  - **Order threading:** the `["tax", amount, currency]` gift-wrap tag, the email `buildTaxSection`, and the dashboard "Sales Tax" column only fire inside the Stripe success handler, so non-card orders carry no tax tag/row.
- **Gating is defense-in-depth, not single-point:** `calculate-tax.ts` skips (returns zero) unless single-seller + charges_enabled + tax_enabled; `create-payment-intent.ts` independently re-checks `tax_enabled` before adding tax to the charge. Multi-merchant carts always skip (per-seller MM tax deferred).
- **Reporting trust boundary:** `record-tax-transaction.ts` reads `taxCalculationId` from the **retrieved, succeeded** PaymentIntent metadata, never from the client; idempotent via `taxtxn_<piId>`.

## On-by-default (sales tax defaults ON)

`tax_enabled` defaults to TRUE. Two non-obvious consequences:

- **Origin config must happen on `add_registration`, not just `enable`.** The Stripe Tax "head office" origin was originally configured only inside the explicit `enable` action. Once tax is on by default, sellers add their states **without ever clicking enable**, so origin config has to run on `add_registration` too (idempotent `ensureTaxOriginConfigured`). Otherwise the registration exists but calculations silently return $0 — a silent failure.
  - **Why:** Stripe Tax calculations require an active settings origin; a registration alone doesn't activate settings.
- **A "flip the default on" migration must be restart-safe.** The init DDL runs on every boot. Backfilling `UPDATE ... SET tax_enabled = TRUE` unconditionally would re-enable any seller who turned it off, every restart. Guard it: a `DO $$` block that only backfills + flips the column default **while `information_schema.columns.column_default` is still `'false'`**. Once it sets the default to TRUE, the guard is false forever after, so it runs exactly once.
  - **How to apply:** any "change a boolean column's default and backfill existing rows" migration done inside always-run init code needs this self-disabling guard, or user opt-outs get clobbered on every deploy/restart.
- The real gate on whether tax is charged is now the seller's **registrations** (no nexus → Stripe returns zero), not the toggle.
