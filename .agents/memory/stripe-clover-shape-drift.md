---
name: Stripe clover/Basil invoice shape drift
description: apiVersion 2025-09-30.clover (Basil family) removed invoice.subscription and invoice.payment_intent; app code still keys off them — verified live in test mode.
---

The app pins `apiVersion: "2025-09-30.clover"` in its Stripe SDK clients (Basil family). Verified against real test-mode API:

- `Invoice` has NO top-level `subscription` — it moved to `invoice.parent.subscription_details.subscription`.
- `Invoice` has NO top-level `payment_intent` — resolve via `stripe.invoicePayments.list({ invoice })` → `payment.payment_intent`, then `paymentIntents.retrieve` for the client_secret. `expand: ["latest_invoice.payment_intent"]` on subscription create silently yields nothing. FIXED for all three subscription-create routes (`create-cart-subscription`, `create-subscription`, `pro/create-subscription`) via the shared dual-shape helper `resolveSubscriptionPaymentIntent` (utils/stripe/subscription-payment-intent.ts); live-verified for the single-seller route by scripts/e2e-single-seller-subscription-clover.mjs (platform-seller path — this test account can't onboard charges-enabled connected accounts).
- `handleInvoicePaid` in pages/api/stripe/webhook.ts starts with `if (!invoice.subscription) return;` — a Basil-shaped `invoice.paid` payload silently no-ops with zero seller transfers and no error. Live webhook endpoints are pinned to "account default" (pre-Basil), so production works today; upgrading an endpoint's API version (or a Stripe default change) silently breaks all multi-seller subscription payouts.

**Why:** mocked unit tests construct pre-Basil payloads, so they stay green while the real API shape drifts — exactly the drift class the staging harness exists to catch.

**How to apply:** any new code reading `invoice.*` or expanding invoice fields must accept both shapes (top-level AND `parent.subscription_details` / `invoicePayments`). Test payload fixtures should include the Basil shape. Related: [stripe-test-mode-e2e](stripe-test-mode-e2e.md).
