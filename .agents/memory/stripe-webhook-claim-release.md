---
name: Stripe webhook claim lifecycle (claim → finalize → release)
description: Stripe events use a three-phase claim (provisional claim, finalize-on-success, release-on-failure); getting the failure/finalize branches wrong either drops retries forever or double-processes.
---

# Stripe webhook dedup: claim → finalize → release

`utils/stripe/processed-events.ts` implements a three-phase claim:

- `claimStripeEvent(eventId, eventType)` — provisionally claims the id (status
  `processing`, fresh `claimed_at`). A concurrent claim or an already-`done`
  event returns false (deduped). A claim only becomes re-claimable after
  `STALE_CLAIM_MS` (~15 min) — this is crash-recovery: a handler that dies
  mid-processing eventually lets a retry back in.
- `finalizeStripeEvent(eventId)` — sets status `done` on the success path.
- `releaseStripeEvent(eventId)` — DELETEs the row so Stripe's retry reprocesses
  immediately.

Both handlers (`pages/api/pro/stripe-webhook.ts`,
`pages/api/stripe/webhook.ts`) claim **outside** the try, process **inside**,
finalize on success, and release in the catch.

**Rule 1 — release on handler failure.** If processing throws after a successful
claim, release the claim in the catch before returning 5xx. Otherwise the claim
dedups every Stripe retry and the event (entitlement activation, lapse,
payment-failed, etc.) is dropped forever.
**Why:** Stripe retries non-2xx for ~30 days, but a surviving claim silently
dedups the retry — turning a transient DB/Stripe error into permanent data loss.

**Rule 2 — do NOT release/500 if only `finalizeStripeEvent` fails.** The
finalize write is bookkeeping that runs _after_ the business side effects already
succeeded. Wrap it in its own `.catch` that logs and still returns 200. If you
let a finalize failure fall into the outer catch, it releases the claim and
returns 500 → Stripe retries → the whole event reprocesses → duplicate side
effects (e.g. a second Pro receipt email; the lifetime grant itself is
idempotent, but not every effect is). Leaving the row as `processing` (fresh
timestamp) keeps retries deduped until the stale window elapses, which is the
safe outcome.

**How to apply:** any new Stripe webhook endpoint mirrors this shape — claim
outside try, process inside, `finalize().catch(log)` + return 200 on success,
release + 500 in the catch. Unit tests that `jest.mock` this module must export
all three (`claimStripeEvent`, `finalizeStripeEvent`, `releaseStripeEvent`) or a
correct handler throws on the missing `finalizeStripeEvent` and 500s.
