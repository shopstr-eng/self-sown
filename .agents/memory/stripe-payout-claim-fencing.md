---
name: Stripe payout-claim fencing
description: payouts Stripe may retry for days need durable claims with rotated fencing tokens — idempotency keys expire ~24h
---

Stripe idempotency keys are only guaranteed for ~24h, but webhook and invoice retries can arrive for days. Any server-initiated payout that must survive that window needs ALL of:

1. A durable (payment-or-invoice-id, seller) claim row taken before the transfer and consulted on every attempt.
2. A fencing token rotated on stale takeover, with token-gated completion/release — a resumed previous owner must fail loudly, never overwrite the replacement owner's claim.
3. Transfer-history reconciliation before creating (adopt a crashed attempt's transfer), failing closed when the search cannot be exhaustive.
4. A fresh claim owned by a live in-flight attempt is retryable, never skipped-as-success — an unresolved claim is not proof of payment.
5. Seller-configured fee/donation percents apply net-of-fee, and every value the settings UI permits (including 100%) must be a first-class payout outcome: skip the zero-amount transfer and record a terminal result. Never validate a stored percent more narrowly than the UI allows, or a paid charge retries forever.

**Why:** each rule above closed a real double-pay, stranded-seller, or permanently-failing-paid-invoice hole found while hardening multi-seller recurring payouts.

**How to apply:** mirror this pattern for any new server-initiated money movement; prove token fencing against a real database, not only mocks.
