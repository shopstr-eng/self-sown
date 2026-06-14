---
name: Stripe receipt_email is not proof of recipient ownership
description: Why gating seller-domain (custom-from) order confirmations on a verified Stripe payment still leaves a paid-attacker, per-target abuse vector.
---

# receipt_email cannot prove the recipient owns the inbox

When deciding whether a buyer's **order-confirmation** email may send from the
seller's OWN authenticated domain (custom-from), the gate verifies a real Stripe
CARD payment to that seller and then pins the recipient to the PaymentIntent's
`receipt_email`. This makes the _seller/payment_ binding unforgeable:

- Single-seller orders are **direct charges on the seller's connected account**,
  so the PI only resolves when retrieved with `{ stripeAccount }` for that
  seller. An attacker cannot produce a succeeded PI on a victim seller's account.
- Multi-merchant carts are platform PIs; the seller must appear in the
  server-built `sellerSplits` metadata (the per-split `accountId` is resolved
  server-side, not trusted from the client).
- Do NOT trust `metadata.sellerPubkey` on a platform PI — it's client-supplied at
  PI creation, so a single-seller-on-platform PI is NOT a trustworthy binding.

**The residual gap:** `receipt_email` is set 1:1 from the caller-supplied
`customerEmail` at PI creation (format-validated only, no ownership check). So a
person willing to actually pay the seller real money can:

1. create + pay a PI to the seller with `customerEmail = victim`, then
2. call send-order-email with that victim address + arbitrary order content,
   and verification returns true → a seller-domain email reaches a recipient the
   attacker doesn't own (one target per paid charge; repeatable to that target
   because the PI isn't consumed/idempotent).

**Why:** there is no server-trusted source of truth for "who is the real buyer of
this order." Orders are encrypted gift wraps (server can't read participants),
and `notification_emails` is written from the same caller input. The only
independent signal is what's on the Stripe charge — which the caller set.

**How to apply:** the card-only gate is correct and dramatically raises the bar
(blocks ALL _free_ spoofing; remaining abuse costs a real, traceable, refundable
charge to the seller). To close further you must either (a) consume each PI once
and bind to a server-recorded payment (kills replay/repeat), or (b) prove the
recipient owns the address (double-opt-in / verified-account binding) to kill the
arbitrary-recipient vector — the same friction that makes the popup case hard.
Fail-closed always: any uncertainty → global verified sender so delivery is never
broken.
