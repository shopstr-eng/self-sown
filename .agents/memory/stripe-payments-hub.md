---
name: Stripe/payments rules hub
description: index of all Stripe + card-payment lessons; open the linked topic file for the full rule, why, and how-to-apply
---

- [Webhook claim release](stripe-webhook-claim-release.md) — claimStripeEvent permanently dedups; release the claim in catch on handler failure or Stripe's retry is silently dropped.
- [Lifetime grant vs live sub](lifetime-grant-stripe-cancel.md) — grantLifetimeMembership only nulls the local sub id; call cancelExistingProSubscription FIRST or the seller keeps getting billed.
- [Lifetime vs subscription webhooks](lifetime-membership-and-subscription-webhooks.md) — keep `lifetime` a sticky column, resolver-checked first.
- [Wrangler lifetime price change](wrangler-lifetime-price-change.md) — change the constant AND bump the Stripe lookup_key (Prices are immutable).
- [Connect auth fallback binding](stripe-connect-auth-fallback.md) — generic "stripe-connect" verifyNostrAuth fallback = cross-endpoint replay vector.
- [receipt_email ≠ recipient ownership](stripe-receipt-email-not-ownership.md) — card-verified custom-from order confirmations block free spoofing but a paying attacker can still target recipients.
- [Connect lifecycle](stripe-standard-connect.md) — OAuth onboarding (HMAC state binding); country immutable (create fails closed); reconnect deletes the account row first.
- [Subscription account binding](subscription-account-binding.md) — cancel/update must target the row's stored connected_account_id (stamped at creation).
- [Webhook endpoint topology](stripe-webhook-endpoint-topology.md) — platform vs connected-account objects need separate endpoints and secrets.
- [Payout-claim fencing](stripe-payout-claim-fencing.md) — payouts retried beyond Stripe's 24h idempotency window need durable claims with rotated fencing tokens + history reconciliation.
- [Apple Pay: Stripe PMD + Square file](apple-pay-association-host-aware.md) — PMD per charge-owning account (platform host = per-seller); disabled PMDs re-enable on checkout.
- [Clover/Basil invoice shape drift](stripe-clover-shape-drift.md) — clover removed invoice.subscription/payment_intent; webhook silently no-ops on Basil-shaped events.
