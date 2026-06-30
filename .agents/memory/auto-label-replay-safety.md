---
name: Auto-action-after-payment replay safety
description: How to make an unauthenticated, money-spending server action that fires after a card payment safe against replay/double-charge.
---

# Auto-action-after-payment replay safety

When the browser fires a server endpoint _after_ a successful card payment to
trigger a money-spending side effect (e.g. auto-buying a shipping label on the
seller's own Shippo account), the endpoint usually takes **no Nostr/auth proof**
— its only authorization is re-verifying the Stripe PaymentIntent
(`status==='succeeded'` + `metadata.sellerPubkey` includes the seller, retrieved
on the connected account then the platform account).

**Rule:** dedupe the side effect on a **server-verified payment identifier**
(the verified `PaymentIntent.id`), never on a client-supplied order id.

**Why:** web checkout generates the `orderId` client-side (a fresh `uuidv4`),
and web PaymentIntents do **not** carry/bind that orderId. If the atomic dedupe
claim is keyed on the client orderId, a buyer holding one genuinely-settled PI
that names a seller can replay the endpoint with a new UUID each time and make
the server buy **unlimited seller-billed labels**. Rate limiting only slows
this; it is not money-safety. The PI metadata check is non-spoofable (we set
metadata server-side) but it only proves _a_ payment to that seller — it does
not bind quantity/order, so one PI must map to at most one action per seller.

**How to apply:**

- Give the shared core an optional Stripe-bound `claimRef`; the claim key is
  `claimRef || orderId`. Web passes `claimRef = pi.id`; MCP/agent orders have a
  real server-side orderId and omit it.
- The permanent "purchased" claim marker is the durable guard — **never prune
  it** (pruning it after N days reopens the exact replay vector; a buyer just
  re-POSTs the old PI with a new orderId). Only prune stale _pending_ claims.
- Keep all skip gates (toggle/entitlement/provider/eligibility/already-bought)
  and the atomic claim BEFORE any charge; release the claim only on a
  pre-charge failure. If the charge succeeded but the history-row insert failed,
  KEEP the claim (the seller was already billed) and log CRITICAL.
