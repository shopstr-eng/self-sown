---
name: Auto-label checkout binding
description: Checkout-time records consumed after payment must be immutable AND keyed by the provider-verified payment id, or an idempotent replay can rewrite them post-settlement.
---

When an unauthenticated post-payment route derives shipping/order data from a
server-side record written at payment creation, that record must be
write-once per payment id (first write wins, never upsert-overwrite).

**Why:** the payment providers' idempotency keys cover only the charge
inputs, not the checkout payload — a caller can replay the identical
creation request after settlement with a swapped payload, get the same
provider payment id back, and (with an upsert) rewrite the "trusted" record
before invoking the post-payment action. Found in review of the auto-label
checkout binding.

**How to apply:** ON CONFLICT DO NOTHING for any security-relevant
checkout-time binding; the write path stays best-effort (warn) and the read
path fails closed on a missing row. Extends auto-label-replay-safety.md.
