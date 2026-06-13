---
name: Wrangler lifetime price change checklist
description: How to change the one-time Wrangler lifetime membership price end-to-end without leaving a stale Stripe Price or stale copy.
---

# Changing the Wrangler (lifetime) membership price

Source of truth is `WRANGLER_LIFETIME_PRICE_CENTS` in `utils/pro/constants.ts`.
The actual card charge is a PaymentIntent created in
`pages/api/pro/create-lifetime.ts` using that constant **directly** — the Stripe
Price object is cosmetic (dashboard only).

When changing the price you must:

1. Update `WRANGLER_LIFETIME_PRICE_CENTS` (and its `// $X` comment). `_USD` is
   derived. Dynamic UI (`pro-checkout.tsx`, `pages/pro/index.tsx`, home FAQ
   amount in `pages/index.tsx`) reads the constant and auto-updates.
2. **Bump `WRANGLER_LIFETIME_LOOKUP_KEY`** (e.g. `_v1`→`_v2`). Stripe Prices are
   immutable and `ensureWranglerLifetimePrice()` does find-or-create by
   `lookup_key`; without the bump the dashboard Price stays at the old amount.
3. The PaymentIntent idempotency key in `create-lifetime.ts` includes `amount`,
   so retries during a price cutover create a fresh PI instead of reusing a
   cached old-price one. Keep that.
4. Update hardcoded copy (grep `1,?050` style for the old number): marketing
   `pages/{index,about,faq,terms,producer-guide}`, `components/structured-data.tsx`
   (JSON-LD), and the machine-readable surfaces `public/llms-full.txt` +
   `utils/geo/page-content.ts` (see `machine-readable-tier-surfaces.md`).
5. Update test fixtures asserting the amount: `__tests__/api/pro/*lifetime*` and
   `utils/db/__tests__/lifetime-settle-db.test.ts` (cents + `$X.00` strings).

**Not affected:** MCP tools only report membership _status_, never price.
The old Stripe Price can be archived in the Dashboard but isn't required for
charge correctness.

**Why:** changing only the constant silently leaves the Stripe dashboard Price
and ~8 hardcoded copy/test surfaces out of sync.
