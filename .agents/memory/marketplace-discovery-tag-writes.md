---
name: Marketplace discovery tag write paths
description: Every kind-30402 listing write path must route tags through normalizeMarketplaceDiscoveryTag; unconditional ["t","SelfSown"] appends are a bug.
---

Any code that builds or rebuilds a kind-30402 product listing event must produce exactly one `["t","SelfSown"]` discovery tag and never carry the legacy `["t","MilkMarket"]` spelling forward. The shared normalizer is `normalizeMarketplaceDiscoveryTag` in `utils/parsers/product-tag-helpers.ts` (strips both spellings, appends one canonical tag, preserves FREEMILK/SAVEBEEF/categories).

**Why:** listings are discovered by the `#t` filter; a dropped tag makes a listing vanish from the marketplace, and a duplicated/legacy tag comes from caller-supplied categories ("MilkMarket"/"SelfSown" typed as a category) slipping past an unconditional append. The failure is silent — publish succeeds.

**How to apply:** when adding or modifying a listing write path (MCP tools, client form, import migrations, republish helpers), never `tags.push(["t","SelfSown"])` after merging user-controllable tags — splice in `normalizeMarketplaceDiscoveryTag(tags)` instead, and cover it with a test asserting exactly one SelfSown and zero MilkMarket.
