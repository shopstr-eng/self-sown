---
name: Stripe webhook endpoint topology
description: Durable rules for account-scoped and Connect webhook delivery
---

Each Stripe webhook route that handles both platform objects and connected-account objects needs separate account-scoped and Connect endpoints. The shared route must verify the signing secret belonging to either endpoint.

**Why:** Events for connected-account objects, including seller-account subscription renewals, are not delivered to account-scoped endpoints. Correct handler retrieval logic cannot recover an event that Stripe never sends.

**How to apply:** Configure both endpoint scopes for every relevant event type, keep their signing secrets distinct, and publish after changing Replit secrets because a running deployment does not receive secret changes. Verify Connect delivery with a harmless connected-account event and confirm it reaches the handler successfully.
