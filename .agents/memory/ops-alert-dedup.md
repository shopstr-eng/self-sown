---
name: Ops-alert per-day dedup
description: Repeatable ops alert emails must be rate-limited per subject through the shared pro_settings-backed helper, stamping only after a confirmed send.
---

Any ops alert email that can fire repeatedly for the same subject (e.g. every billing cycle for a live legacy Stripe subscription) must be rate-limited per subject (24h) via the shared deduped-ops-alert helper, which serializes check→send→stamp with a per-key Postgres advisory lock and persists the dedup timestamp in pro_settings.

**Why:** an orphaned-but-live subscription otherwise emails ops the identical alert every billing cycle; an unguarded read→send→write lets two concurrent webhook events both send. Stamping the dedup key before/without a confirmed send permanently silences re-alerts after a transient mail failure.

**How to apply:** route new repeatable ops alerts through the shared helper instead of hand-rolling a cooldown; keep the structured console log on every event (only the email is suppressed), and never let the helper throw into a webhook handler (the response must stay 200 when retry is pointless).
