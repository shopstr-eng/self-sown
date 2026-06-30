---
name: Alternative per-seller card processor (Square alongside Stripe)
description: Durable design rules when adding a second per-seller card processor (Square) as a bidirectional XOR alternative to Stripe Connect.
---

# Adding an alternative per-seller card processor

The marketplace lets a seller pick EITHER Stripe Connect OR Square (never both) as
their own card processor. When wiring a new processor like this, these are the
non-obvious rules that bit us / that a review caught:

## Config-gate must require EVERY behavior-changing env, not just credentials

`isSquareConfigured()` originally checked only the OAuth id+secret. But
`getSquareEnvironment()` defaults to `"sandbox"` when `SQUARE_ENVIRONMENT` is
unset — so a production deploy with id+secret but no environment would silently
run Square in **sandbox** instead of being unavailable.
**Why:** "fail-closed when secrets unset" means the gate must require _all_ env
that changes runtime behavior (including the environment selector), or a partial
config degrades to an unsafe default rather than off.
**How to apply:** any `isXConfigured()` that feeds a function with an env-driven
default must require that env too (e.g. `env === "sandbox" || "production"`).

## autocomplete charge success = COMPLETED only, never APPROVED

The buyer card-charge route created the Square payment with `autocomplete:true`,
then accepted both `COMPLETED` and `APPROVED` as success. `APPROVED` means the
funds are only **authorized, not captured**, and there is no capture path — so
accepting it would fire seller order DMs/emails and confirm the order against
uncaptured money.
**Why:** treating an authorize-only state as paid silently ships unpaid orders.
**How to apply:** for any auto-capture charge, success is the terminal captured
status only (`COMPLETED`); anything else is a failure/retry path.

## Bidirectional XOR is enforced at BOTH write endpoints, server-side

Square OAuth start/callback refuse if a Stripe Connect row exists; Stripe
create-account refuses if a Square connection row exists. UI choice/precedence
is only a safety net — the server is the control.

## Processor-agnostic success; gate Stripe-only post-payment work

The success handler is `handleCardPaymentSuccess({processor,paymentId})`. Stripe
-only follow-on work (Stripe tax transaction, process-transfers, auto-Shippo
label) must be gated behind `processor==='stripe'`. Square auto-labels are out of
v1.

## Multi-seller card with a Square seller = SEQUENTIAL per-seller charges (no combined charge)

There is no way to combine charges across separate Stripe + Square accounts, so a
multi-seller cart that contains a Square seller charges **each seller separately,
one card-entry step at a time** (a queue in `cart-invoice-card.tsx`), each on that
seller's OWN account. The all-Stripe multi-seller cart still uses the single
combined multi-merchant PaymentIntent (sellerSplits + transfer_group) — only carts
that include ≥1 Square seller fall into the sequential path.
**Why:** Square has no Connect-style transfer group; you cannot split one charge
across heterogeneous processors.
**How to apply (the rules that make sequential safe):**

- Each Stripe leg is a _single-seller direct charge_ (`metadata.sellerPubkey` +
  `isCart`, **NO sellerSplits**) so it lands on that seller's account — never fold
  cart context into multi-merchant mode (pinned by a direct-charge route test).
- Each seller's order DMs + auto-ship fire **incrementally** as that seller is
  charged (`sendSellerCardOrderEffects`), so a paid seller is always notified even
  if the buyer abandons a later step.
- Accumulate paid sellers in a ref and skip already-paid sellers on resubmit, and
  reuse one shared order id — or a retry double-charges / splits the order.
- Multi-seller carts have **no payment-method discount and no sales tax** (both
  single-seller only), so each per-seller charge = items + discounted shipping =
  the amount in that seller's DM/email. Subscriptions aren't supported in the
  sequential flow (v1).
- Eligibility (`multiSellerCardEligible`) fails closed: every seller must resolve
  to a processor, ≥1 must be Square, and every Square seller's location currency
  must match the cart charge currency (USD for sats carts).
- **Known v1 limitation:** order _emails_ are flushed only at finalize (last
  seller), so abandoning mid-sequence means paid earlier sellers got their DM but
  not their email — candidate follow-up.

## Buyer charge resolves everything server-side

The unauthenticated, rate-limited create-payment route resolves seller →
connection/location/currency from the DB and ignores any client-supplied token/
location; only the card nonce + buyer-facing amount/currency come from the
client, and the amount is validated against the location currency before
charging. Crypto (sats/BTC) is chargeable only when the location settles in USD.
