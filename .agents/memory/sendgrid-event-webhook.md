---
name: SendGrid Event Webhook receiver
description: Durable invariants for the async-bounce suppression webhook (auth, permanence, always-200, body cap)
---

SendGrid accepts most dead-address sends and reports the bounce asynchronously; the event webhook receiver suppresses those between daily cron-sync runs. Invariants that must hold:

- **Fail closed on auth.** No verification key or bad Ed25519 signature = 401, zero processing — a forged bounce batch would let anyone wipe a seller's email audience.
- **Always 200 after verification.** SendGrid re-posts the WHOLE batch on non-2xx; per-event suppression is best-effort, failures only logged, cron sync re-covers misses.
- **Suppress only provably permanent outcomes.** Per-seller suppression rows never expire: skip soft bounces (type=blocked) and drops without a permanent reason (suppression-list/invalid causes). A false positive permanently shrinks a seller's audience; a false negative is re-covered by the daily sync. Same policy as the sync excluding the transient blocks list.
- **Cap the raw body while streaming.** bodyParser is off for signature verification, which removes Next.js's size limit — reject oversized payloads before buffering, prior to verification.

**Why:** synchronous 4xx suppression never sees accepted-then-bounced addresses; without this receiver they get re-emailed by every broadcast, and a sloppy receiver is a permanent audience-wipe or memory-exhaustion vector.
**How to apply:** when touching the webhook or broadcast senders, preserve seller attribution via the stamped custom arg, fail-closed auth, the permanence filter, the always-200 posture, and the streaming byte cap.
