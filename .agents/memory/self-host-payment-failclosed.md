---
name: Self-host card payment fail-closed gating
description: Where and why self-host (Wrangler) card-payment authorization must live — the payment endpoint, not the card-availability UI.
---

# Self-host card payment must fail closed at the payment endpoint

In self-host (Wrangler/lifetime single-tenant) mode card charges land directly
on the OWNER's own standard Stripe account (no Connect, no fees). Every guard
that decides whether a card charge may happen must be enforced **server-side in
the payment-intent creation route**, before any Stripe call. The three guards:

1. reject multi-merchant carts,
2. reject unless own-Stripe is enabled AND a Stripe key is configured,
3. reject any `sellerPubkey` that is not the configured tenant (`isSelfHostTenant`).

**Why:** The card-availability route (`seller-status`) only controls whether the
UI _shows_ the card button — hiding a button is presentation, not authorization.
A direct API caller bypasses the UI entirely. Without the server-side own-Stripe
gate, a caller could create a card charge even when the owner explicitly turned
own-Stripe off; without the tenant-pubkey gate, the owner's Stripe account could
be billed for another seller's listing. Both are fail-open security holes.

**How to apply:** When touching self-host payments, keep authorization in the
payment route and treat `seller-status` as display-only. `isSelfHostTenant` and
`getSelfHostConfig().ownStripe` both fail closed (false when self-host off /
tenant pubkey absent / key missing), so build guards as
`selfHost && <bad condition> -> refuse`. Keep all branches gated on
`selfHostCfg.enabled` so default hosted behavior is untouched. General rule:
proxy/payment self-host paths fail closed (e.g. missing slug -> 503, not
fall-through).
