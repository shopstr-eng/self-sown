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
- The OAuth state carries whitelisted return-target flags (`app` for mobile, `ret` for the web landing page) that only select between fixed server-side redirect targets (settings page, onboarding step, selfsown:// deep link) — never a caller-supplied URL, so no open redirect. Mobile flows 302 from the callback straight into the app scheme, which openAuthSessionAsync intercepts; declined/errored app flows bounce to the BARE deep link (no status params) so the app can't misreport them as success.
- Exposed on every connect surface: settings/payments, onboarding step, StripeConnectModal, and the mobile dashboard ("I already have a Stripe account" link next to the Express country picker). Web proofs sign buildStripeStandardStartProof; mobile signs createSignedStripeConnectAuthEvent for the start path only.
- Tap to Pay / Stripe Terminal is account-type agnostic (verified against Stripe's Terminal Connect + capabilities docs, 2026-11): direct charges use the platform key + Stripe-Account header with no account-type restriction, and card_payments (reflected in our charges_enabled gate) is the only capability requirement — no tap_to_pay capability exists. The Terminal connection-token and PoS payment-intent routes intentionally do NOT branch on account_type (regression test: **tests**/api/stripe/terminal-connection-token.test.ts). Caveat from Stripe's docs: OAuth-connected accounts must be authorized with the platform's client id FOR THE MODE in use — a live client id doesn't cover test-mode tokens. Live end-to-end verification on a real linked Standard account is still pending (no Standard account can be created via API; requires human OAuth).

**Why:** Sellers with an existing Stripe account must never be funneled into creating a new Express account — the Standard OAuth link REPLACES the local row, which is also the migration path.

Related: stripe-connect-regional.md, stripe-connect-disconnect.md
