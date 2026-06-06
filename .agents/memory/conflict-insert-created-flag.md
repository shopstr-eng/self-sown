---
name: ON CONFLICT granters must return + gate on a created flag
description: Why one-time INSERT ... ON CONFLICT DO NOTHING grants must surface whether a row was actually created, and callers must gate success UI on it.
---

A one-time grant backed by `INSERT ... ON CONFLICT DO NOTHING` (e.g. the Pro
free-trial granter) silently no-ops when a row already exists. The DB layer must
return whether a row was actually created (rowCount > 0), the server granter must
propagate it, and the **client must gate the success state on `created` (or the
freshly-resolved status), not on a 200 response.**

**Why:** A 200 with `created=false` means "you already had a membership." If the
client shows "trial active" on any 200, a stale or replayed client can fake a
trial for an existing payer/trialer and grant the entitlement twice in the UI.

**How to apply:** When granting one-time entitlements idempotently, thread the
boolean back to the caller and branch on it (fresh grant → success; conflict →
surface real state / paywall). Also fail-closed on the seller-only onboarding
choose-plan step: only `type=seller` may stay; everything else redirects out.
