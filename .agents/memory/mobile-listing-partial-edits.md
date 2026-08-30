---
name: Mobile listing partial edits
description: Durable rules for safe mobile edits and retryable Nostr listing publication.
---

Mobile listing CRUD is a partial editor: replace only the basic tag families the mobile UI owns and preserve every unsupported product tag exactly.

**Why:** Reconstructing an event solely from mobile-visible fields silently deletes advanced web configuration. Separately, relay publication and local cache writes are not atomic; treating accepted relay events as failed can encourage duplicate addressable listings.

**How to apply:** Carry source tags and source timestamps through edits and status changes. Strip/rebuild only mobile-owned tags. Publish the primary event to relays first, treat later cache/discovery writes as best-effort, retain the generated `d` tag for retries, and make replacement timestamps strictly newer than the source event.
