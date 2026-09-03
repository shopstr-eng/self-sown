---
name: Stripe webhook endpoint topology
description: Durable rules for account-scoped and Connect webhook delivery
---

Each Stripe webhook route that handles both platform objects and connected-account objects needs separate account-scoped and Connect endpoints. The shared route must verify the signing secret belonging to either endpoint.

**Why:** Events for connected-account objects, including seller-account subscription renewals, are not delivered to account-scoped endpoints. Correct handler retrieval logic cannot recover an event that Stripe never sends.

**How to apply:** Configure both endpoint scopes for every relevant event type, keep their signing secrets distinct, and publish after changing Replit secrets because a running deployment does not receive secret changes. Verify Connect delivery with a harmless connected-account event and confirm it reaches the handler successfully.

Two orphan-signal corollaries: (1) the Pro webhook endpoint receives invoice events for ALL platform-account subscriptions, not just Pro ones, so any missing-local-row marker must be gated on isProMembershipSubscription or non-Pro invoices drown it; (2) a webhook lookup returning null on a Connect event can also mean the object lives on a connected account the platform can't retrieve — confirm genuinely-orphaned vs wrong-account before treating null as permanent.
