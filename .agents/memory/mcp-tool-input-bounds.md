---
name: MCP tool input bounds live in the zod schema
description: Agent-supplied numeric inputs on MCP tools are enforced by the registered zod schema; the SDK returns an isError result (not a throw) on validation failure.
---

For MCP tools (pages/api/mcp/index.ts `reg`, mcp/tools/*), input hardening belongs in the zod schema registered with the tool — the MCP SDK validates arguments before the callback runs, so `.int().min().max()` on the schema is the whole enforcement. Bare `z.number()` accepts 1e9 or negatives, which flow straight into SQL LIMIT/OFFSET.

**Why:** An agent could pass limit=1000000000 and make one request scan/serialize the whole mcp_orders table. The sibling REST route clamped, but the MCP tools shared no bounds.

**How to apply:** When adding an MCP tool param that feeds a query or charge, put the bound on the schema. When testing: drive the tool through a real McpServer + InMemoryTransport + Client (validation is SDK-side, calling the callback directly bypasses it); validation failures resolve as `{ isError: true, content: [{ text: "MCP error -32602 ..." }] }` rather than rejecting. registerPurchaseTools is exported from pages/api/mcp/index.ts for exactly this; its module-scope setInterval is unref'd so importing it doesn't hang Jest. Pattern: __tests__/pages/api/mcp/pagination-bounds.test.ts. Two caveats learned the hard way: (1) bounds must match the runtime unit contract of the consuming UI (a "speed" field may be seconds in one section type and milliseconds in another — check the renderer, not the describe text); (2) the raw-shape registration can't express cross-field rules (e.g. percent-vs-fixed value caps), so discriminator-dependent limits go in the tool callback as an isError result, and money values must stay within the backing NUMERIC(12,2) column (max 9999999999.99).
