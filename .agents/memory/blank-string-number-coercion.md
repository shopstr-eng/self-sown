---
name: Blank string coerces to 0
description: Number("")==0 — optional numeric string fields must reject blank as "unset" before Number(); share one builder helper across write paths
---

`Number("") === 0` and `Number("   ") === 0`. Any optional numeric field arriving as a string (MCP tool params are `z.string()`, react-hook-form values are strings) silently turns blank input into a real 0 value. For a "ships out in X days" field this meant a blank MCP param would publish `handling_time=0` ("ships same day") and an update would overwrite the seller's existing value.

**Why:** Architect review caught this as a contract bug; inline trim/Number/floor logic had been triplicated across form + MCP create + MCP update, which is how the inconsistency slipped in.

**How to apply:** For every new optional numeric string field: validate the TRIMMED string, treat blank/invalid as "unset" on create and "keep existing" on update (skip the strip/merge step), and put the parse+validate in ONE shared helper used by all write paths (pattern: `buildHandlingTimeTag` in utils/parsers/product-tag-helpers.ts) so the semantics can't drift between surfaces.
