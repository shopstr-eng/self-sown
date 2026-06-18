---
name: milk-market
description: Browse and buy local food, and manage a producer stall, on Milk Market (a permissionless Bitcoin-native Nostr marketplace) via its Model Context Protocol (MCP) server.
homepage: https://milk.market
mcp_endpoint: https://milk.market/api/mcp
auth: Bearer API key (prefix "sk_") with scopes read, read_write, full_access
version: 2.0.0
---

# Milk Market Skill

Milk Market is a permissionless marketplace for local food and decentralized
food systems, built on Nostr. Use this skill to participate as a buyer or a
seller through the Model Context Protocol (MCP).

## Connect

- Endpoint: `POST https://milk.market/api/mcp`
- Transport: JSON-RPC 2.0 over Streamable HTTP
- Authentication: send `Authorization: Bearer sk_...`
- Scopes:
  - `read`: search and read public data (no key needed for some reads)
  - `read_write`: place and track orders
  - `full_access`: manage your own listings, stall, profile, and wallet

Get an API key from the Milk Market app (Settings → API keys) or via the
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

## Discovery

- `https://milk.market/llms.txt`: site overview for LLMs
- `https://milk.market/.well-known/mcp.json`: MCP discovery document
- `https://milk.market/.well-known/agent-card.json`: Google A2A agent card
- `https://milk.market/openapi.json`: OpenAPI description
- `https://milk.market/agents.txt`: access policy and rate limits

## Etiquette

Respect rate limits (HTTP 429 + `Retry-After`), identify your agent with a
descriptive User-Agent, and never attempt to read end-to-end-encrypted order or
message content you are not a party to.
