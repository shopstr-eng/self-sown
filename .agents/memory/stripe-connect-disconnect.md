---
name: Stripe Connect disconnect / reconnect
description: How sellers unlink a Stripe Express account so they can connect a different one, and why it's unlink-only.
---

# Stripe Connect disconnect / reconnect

Sellers (keyed by Nostr pubkey) can disconnect their Stripe Express account from the Payments settings page and then connect a different / fresh one.

## Reconnect requires deleting the row first

`create-account` (`pages/api/stripe/connect/create-account.ts`) **short-circuits and returns the existing account** whenever `getStripeConnectAccount(pubkey)` finds a row with a `stripe_account_id`. So a seller can never connect a _different_ account while the old `stripe_connect_accounts` row exists — the disconnect path must hard-`DELETE` that row (UNIQUE pubkey). After deletion, `account-status` reports `hasAccount: false` and the UI falls back to the normal "Set Up Stripe" flow, which creates a brand-new Express account.

**Why:** the pubkey row is the single source of truth for "is this seller connected"; nothing recreates it behind the seller's back (the `account.updated` webhook only writes to `affiliates`, not `stripe_connect_accounts`).

## Disconnect is unlink-only — do NOT delete/close the account at Stripe

`disconnectStripeConnectAccount(pubkey)` only removes our DB link. It deliberately makes **no** Stripe API call to delete or deauthorize the connected account.

**Why:** the Express account may hold a balance or pending payouts; deleting it could disrupt the seller's funds. Leaving it orphaned at Stripe is harmless — the seller manages or closes it there.

**How to apply:** any future "remove a seller's payment connection" work should unlink locally and leave the provider account intact unless the user explicitly asks to close it. In-flight payments/transfers are safe because `process-transfers.ts` / `webhook.ts` route via the `split.accountId` captured at payment time, not a live pubkey lookup; the only post-disconnect failure mode is renewals of active buyer subscriptions whose splits lack an embedded accountId (logged as transfer failures, same as a never-connected seller).

Auth mirrors the sibling connect endpoints: `buildStripeDisconnectProof` + `verifyAndConsumeSignedRequestProof` (pubkey-bound, replay-protected) with a `verifyNostrAuth` fallback. Not Pro-gated.
