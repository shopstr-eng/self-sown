---
name: Lifetime membership vs subscription webhooks
description: How a one-time lifetime (Wrangler) grant coexists safely with recurring Stripe subscription webhooks without being downgraded or double-charged.
---

# Lifetime (Wrangler) grant vs recurring subscription webhooks

When a paid tier offers BOTH a recurring subscription (Herd) and a one-time
lifetime purchase (Wrangler), the lifetime grant and the recurring-subscription
webhooks fight over the same `pro_memberships` row. The design that keeps them
consistent:

- **`lifetime` is a sticky column.** Only the lifetime grant
  (`grantLifetimeMembership` / `LIFETIME_GRANT_SQL`) ever sets it TRUE. The
  Stripe subscription writers (`applyProStripeState`, `syncProStripeMeta`) must
  NEVER touch the `lifetime` column. The status resolver checks `row.lifetime`
  FIRST and returns active regardless of `status`/timeline.
  **Why:** this makes entitlement survive every webhook ordering
  (cancel-before-grant, deleted-after-grant, renewal-after-grant) without
  transactions — whichever write runs last, `lifetime` stays TRUE.

- **The lifetime grant's `ON CONFLICT DO UPDATE` must fully neutralize the
  recurring state**, not just flip `lifetime`: set `term=NULL`,
  `stripe_subscription_id=NULL`, and null the timeline windows
  (`current_period_end`, `grace_until`, `readonly_until`). A conflict branch that
  only sets `lifetime=TRUE` leaves a stale `term`/period and a live sub id.

- **Cancel the recurring sub when granting lifetime, but treat it as
  best-effort + auto-retried, never blocking.** Put a guard at the TOP of the
  subscription→membership mapper (`applyStripeSubscriptionToMembership`): if the
  current row is `lifetime`, cancel the incoming sub (when not already
  canceled/incomplete_expired) via `withStripeRetry` and RETURN EARLY before any
  state write. This single guard does three jobs: (1) stops clobbering the
  lifetime row, (2) makes every later renewal/`customer.subscription.*` webhook
  an automatic cancellation retry, bounding ongoing charges to ≤1 cycle, (3) is
  gated strictly on `current.lifetime` so normal subscribers are untouched.
  **How to apply:** the mapper resolves pubkey from `sub.metadata.mmProPubkey`,
  so the guard still finds the member even after the grant nulled the DB
  `stripe_subscription_id`.

- The same `cancelExistingProSubscription(pubkey)` helper is called before the
  grant in all three rails (Stripe PaymentIntent webhook, and the two manual
  settle routes `confirm-invoice.ts` / `verify-invoice.ts`, guarded by
  `invoice.lifetime`). Cancel-before-settle is safe because settle is
  atomic+idempotent and the cancel is idempotent on retry.

- **A lifetime grant must also cancel the seller's still-open (pending) manual
  invoices**, or a stale Herd invoice can later be polled/settled and stack a
  paid term on top of lifetime (plus drive the expiry sweep and reminders).
  Reminders themselves already no-op for lifetime (resolver returns active), so
  the gap is purely the open invoices.
  **Lock-ordering rule:** any transaction that touches both `pro_manual_invoices`
  and `pro_memberships` for one seller MUST lock the invoice rows FIRST and the
  `pro_memberships` row LAST. The non-lifetime settle already does invoice→
  membership; the lifetime paths had it reversed and deadlocked under concurrent
  settle. Keep membership the final lock in every path.
  **Why:** mixed ordering forms an invoice↔membership cycle Postgres aborts as a
  deadlock. Residual invoice↔invoice contention (two concurrent settles for the
  same seller) is acceptable — it self-heals via deadlock abort + idempotent
  retry.
