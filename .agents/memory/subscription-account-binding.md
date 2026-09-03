---
name: Stripe subscription account binding
description: cancel/update a recurring subscription must target the Connect account stored on the subscription row, not the seller's current account
---

Recurring Stripe subscriptions are bound at creation time to the Connect account they were created on (`subscriptions.connected_account_id`, recorded by both creation routes). Every cancel/update path — MCP tools AND the API routes — must prefer that stored column and only fall back to the seller's current `getStripeConnectAccount(pubkey)` (or caller-supplied id) for legacy NULL rows.

**Why:** a seller who disconnects Stripe and reconnects a DIFFERENT account would otherwise have cancel/update target the new account, miss the subscription at Stripe, and lose any way to stop the old recurring charges.

**How to apply:** any new code path that cancels/updates/retrieves a subscription by id must resolve the account from the row's `connected_account_id` first; any new subscription-creation path must stamp it (multi-merchant cart subs live on the platform account → NULL). Pre-existing NULL rows need the Stripe-verified backfill (follow-up task) before they benefit.
