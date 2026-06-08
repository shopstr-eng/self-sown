---
name: MCP create_order tool/route contract
description: The MCP create_order tool layer and the create-order route are two separate parameter contracts that must be threaded together; recurring orders reuse the web Stripe subscription endpoint.
---

# MCP create_order: tool layer vs route contract

The buyer order MCP tool (`create_order`, registered in `pages/api/mcp/index.ts`) and
the route it self-fetches (`pages/api/mcp/create-order.ts`) have **independent
parameter contracts**. The tool exposes a Zod `inputSchema` + a destructure + a
forwarded JSON body. Adding (or requiring) a field in the route is invisible to
agents unless you ALSO add it to the tool's schema, destructure, AND forwarded body.

**Why:** when subscription support was added, the route began requiring `buyerEmail`
for recurring orders, but `buyerEmail` was never in the tool schema — so every
agent-driven subscription would have failed at runtime with a 400 the agent could
not satisfy. Threading a route field through all three tool surfaces is mandatory.

**How to apply:** any new create_order field = edit `index.ts` (schema entry +
callback destructure + the body sent to `/api/mcp/create-order`) and the route's
body parse together, in lockstep.

# Recurring (Subscribe & Save) via MCP

Recurring orders are Stripe-only (Bitcoin/Cashu/fiat rejected), matching the web
`hasSubscriptionStripeConflict` rule. The MCP path forces `paymentMethod=stripe`
when `subscriptionFrequency` is present, validates against the seller-defined
`product.subscriptionFrequency` list + `product.subscriptionEnabled`, then
**self-fetches the existing `/api/stripe/create-subscription`** route
(`http://localhost:${PORT}`) rather than duplicating Stripe logic.

**Why:** the web subscription endpoint already centralizes Stripe Connect, donation
application-fee, affiliate coupon, idempotency, and the `subscriptions`-table insert.
Duplicating it on the MCP path would drift. Self-fetch mirrors how the order tool
already reaches create-order. It returns a 402 + Stripe `clientSecret` to confirm
the first payment, same shape as the one-off Stripe path.
