---
name: Lifetime grant vs live Stripe subscription
description: Granting/switching a seller to lifetime (Wrangler) does NOT stop their recurring Stripe charge by itself.
---

Switching a seller to a lifetime membership must cancel their live recurring
Stripe subscription as a SEPARATE step. `grantLifetimeMembership` only nulls the
local `stripe_subscription_id` in `pro_memberships`; it does not touch Stripe, so
the subscription keeps billing at Stripe unless cancelled.

**Why:** the DB row and the Stripe object are independent. Clearing the local id
hides the sub from our side but leaves the live recurring charge intact —
double-charging a seller who now has free/lifetime access.

**How to apply:** call `cancelExistingProSubscription(pubkey)` (utils/pro/membership.ts —
best-effort, reads the membership to capture the id BEFORE the grant nulls it,
cancels immediately not at period end, logs/alerts on failure without blocking)
BEFORE `grantLifetimeMembership(...)`. This is the order the paid lifetime-purchase
path (`applyStripeLifetimePayment`) uses, and the same order the one-time
grandfather backfill (`scripts/grandfather-custom-stall-lifetime.ts`) uses. For a
free grandfather grant use `billingMethod: "manual"` (ProBillingMethod is only
`stripe | manual`; manual is the correct non-Stripe provenance marker).
