---
name: Stripe Standard Connect (OAuth) alongside Express
description: Seller-owned Standard accounts link via OAuth with HMAC state binding; account_type column distinguishes them from Express; Express-only surfaces (login links) must reject standard accounts.
---

Milk Market supports two Stripe Connect account types, tracked by `stripe_connect_accounts.account_type` ('express' | 'standard', default 'express'):

- **Express** = platform-hosted (created via API, Express dashboard login links).
- **Standard** = seller-owned full Stripe account, linked via OAuth (`standard/start.ts` → authorize URL, `standard/callback.ts` → token exchange + upsert). The callback REPLACES any existing row (upsert on pubkey) — that IS the Express→Standard migration path; the old account is left untouched at Stripe.

**Why:** Sellers wanted their existing Stripe account / full dashboard. Standard was chosen over Custom (Custom gives sellers NO dashboard and would make us collect KYC/bank data ourselves).

**How to apply:**

- The OAuth callback is unauthenticated — the HMAC-signed state (`utils/stripe/standard-oauth.ts`, SESSION_SECRET, 15-min TTL, timingSafeEqual) is the ONLY seller binding. Never exchange a code without verified state.
- `upsertStripeConnectAccount(..., accountType?)`: only linkage-changing callers pass the type; status-refresh callers omit it (COALESCE preserves existing). Omitting it must never downgrade standard→express.
- Express-only Stripe APIs (createLoginLink, accountLinks) fail for standard accounts — manage-link.ts rejects them; any new Express-only surface must branch on account_type.
- Standard sellers manage everything at dashboard.stripe.com (no manage-link UI).
- Gated fail-closed on STRIPE_CLIENT_ID (+ secret + base URL) via utils/stripe/connect-config.ts, mirroring the Square pattern. The redirect URI must be registered in the platform's Stripe Connect settings.
