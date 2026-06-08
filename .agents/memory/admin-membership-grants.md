---
name: Admin manual membership grant/revoke
description: How admin grant/revoke of Pro/lifetime must guard against Stripe webhook resurrection and the lifetime flag.
---

# Admin manual membership grant/revoke

Admin can manually grant timed Pro, grant Wrangler lifetime, or revoke a seller's
membership from the gated admin page.

## Rule: revoke must permanently deny-list the revoked Stripe subscription id

A plain "cancel sub + clear local row" revoke is NOT durable. The recurring
webhook (`applyStripeSubscriptionToMembership`) resolves the seller pubkey from
the Stripe subscription _metadata_, not from the local `stripe_subscription_id`,
so nulling the local id does not stop a stale/in-flight `active` webhook (or a
delayed Stripe retry) from re-granting via `applyProStripeState`.

**Why:** Stripe delivers (and retries) the event payload as a snapshot taken at
event time; an `active` snapshot can land after the admin revoke.

**How to apply:** On revoke, read the membership FIRST, then write a permanent
deny-key to `pro_settings` keyed by the _subscription id_
(`admin_revoked_subscription:<subId>`) BEFORE cancelling/clearing — if that write
(or the lookup) fails the whole revoke aborts (never half-applied). The webhook,
right after the lifetime guard, returns early for any event whose subscription id
is on the deny-list. Key by subscription id (not pubkey) and never clear it: a
genuine re-subscribe uses a NEW id that isn't listed, so it still grants while
old-sub late retries stay blocked forever.

## Rule: timed-Pro grant must clear the lifetime flag

Granting a fixed manual term to a former Wrangler (lifetime) member must set
`lifetime = FALSE`, or `resolveMembershipStatus` short-circuits to "active"
forever and the term is ignored. `applyProManualState` carries the
`lifetime = FALSE` clause (it has no other callers).

## Decision: grant-pro does NOT cancel an existing Stripe subscription

A courtesy timed grant is additive; cancelling a seller's paid recurring sub as a
side effect of "granting" extra time would be wrong. If they keep paying, Stripe
remains source of truth and renewal webhooks overwrite the manual grant — that is
acceptable. Only grant-lifetime and revoke cancel the existing subscription.

## Revoke resolves to "free", not "hidden"

`revokeProMembership` nulls the entire lapse timeline (period/grace/readonly/
trial) AND lifetime, so the resolver returns "free" (a clean downgrade), not the
lapsed "hidden" state that would also hide their existing content.
