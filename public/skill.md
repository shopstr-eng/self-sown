---
name: milk-market
description: Browse and buy local food, and manage a producer stall, on Self-sown (a permissionless Bitcoin-native Nostr marketplace) via its Model Context Protocol (MCP) server.
homepage: https://self-sown.com
mcp_endpoint: https://self-sown.com/api/mcp
auth: Bearer API key (prefix "sk_") with scopes read, read_write, full_access
version: 2.1.0
---

# Self-sown Skill

Self-sown is a permissionless marketplace for local food and decentralized
food systems, built on Nostr. Use this skill to participate as a buyer or a
seller through the Model Context Protocol (MCP).

## Connect

- Endpoint: `POST https://self-sown.com/api/mcp`
- Transport: JSON-RPC 2.0 over Streamable HTTP
- Authentication: send `Authorization: Bearer sk_...`
- Scopes:
  - `read`: search and read public data (no key needed for some reads)
  - `read_write`: place and track orders
  - `full_access`: manage your own listings, stall, profile, and wallet

Get an API key from the Self-sown app (Settings → API keys) or via the
onboarding endpoint.

## Common tasks

### Find products
Call `search_products` with optional `keyword`, `category`, `location`,
`minPrice`, `maxPrice`, `currency`, and `limit`. Then `get_product_details`
with a `productId` for the full listing.

### Place an order
Call `create_order` with `productId`, optional `quantity`, `buyerEmail`,
`discountCode`, and `paymentMethod` (`stripe`, `lightning`, `cashu`, or `fiat`).
Track it with `get_order_status` and confirm Lightning payments with
`verify_payment`.

### Sell
Use `set_shop_profile` and `create_product_listing` to open a stall and list
products. Update with `update_product_listing`, remove with `delete_listing`,
and manage discounts with `create_discount_code` / `list_discount_codes`.

### Communicate
Use `send_direct_message` for encrypted (NIP-17) messages to buyers or sellers.

## Universal Commerce Protocol (UCP)

If you prefer plain REST over MCP's JSON-RPC, Self-sown also speaks the
Universal Commerce Protocol (the standard backed by Google and Shopify). It runs
on the same catalog and order pipeline as MCP, so the two never drift.

- Discovery: `GET https://self-sown.com/.well-known/ucp` advertises a catalog
  capability and a checkout capability, each with a JSON Schema.
- Browse: `GET /api/ucp/catalog/search` (filters + pagination) and
  `GET /api/ucp/catalog/lookup` (single product, live inventory). No key needed.
- Buy: `POST /api/ucp/checkout/sessions` creates a checkout session that places a
  Self-sown order; `GET /api/ucp/checkout/sessions/{id}` tracks its status.
  These require a `read_write` API key (the same `sk_` keys as MCP).
- Schemas: `/api/ucp/schemas/product.json` and
  `/api/ucp/schemas/checkout-session.json`; everything is also in `/openapi.json`.

## Discovery

- `https://self-sown.com/llms.txt`: site overview for LLMs
- `https://self-sown.com/.well-known/mcp.json`: MCP discovery document
- `https://self-sown.com/.well-known/ucp`: Universal Commerce Protocol profile
- `https://self-sown.com/.well-known/agent-card.json`: Google A2A agent card
- `https://self-sown.com/openapi.json`: OpenAPI description
- `https://self-sown.com/agents.txt`: access policy and rate limits

## Etiquette

Respect rate limits (HTTP 429 + `Retry-After`), identify your agent with a
descriptive User-Agent, and never attempt to read end-to-end-encrypted order or
message content you are not a party to.
