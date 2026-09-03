---
name: DB lookups must not swallow outages as null
description: Webhook/API handlers using db-service lookups need throw-on-error (null = genuinely missing) so transient DB failures 500 and retry instead of silently dropping paid events.
---

`getSubscriptionByStripeId` (and similar db-service accessors) used to catch DB errors and return null. In webhook handlers that made a transient outage indistinguishable from a missing row: the handler silently broke out with a 200, Stripe never retried, and a paid renewal was dropped with no trace.

**Rule:** read accessors feeding payment/webhook flows must rethrow on DB error (callers that want null-on-error add their own `.catch`, as webhook.ts's handleInvoicePaid already does). The handler then treats null as "genuinely missing" (log a loud greppable marker, e.g. ORPHANED_SUBSCRIPTION_PAYMENT, return 200) and lets throws hit the outer catch (500 + `releaseStripeEvent` so Stripe's retry isn't deduped). Beyond subscriptions, the money-path accessors that follow this rule: `getStripeConnectAccount`, `getSellerNotificationEmail`, `getBuyerNotificationEmail`, `getUserAuthEmail`, `validateDiscountCode`, `getDiscountCodesByPubkey`. The multi-seller transfer loop resolves all Connect account ids BEFORE the first `transfers.create` because transfers are not idempotent across a webhook retry — a lookup outage must abort before any money moves.

**Why:** a paid event that finds no local row and a paid event whose lookup failed need opposite handling — 200-with-alert vs 500-with-retry. Collapsing both to null picks neither.

**How to apply:** when adding a db-service accessor consumed by a webhook/payment route, don't catch-and-return-null; and when a webhook finds no row for an event where money moved, log a distinct ALL_CAPS marker with ids/amounts instead of a bare `break`.
