---
name: Mirroring JS logic in SQL functions
description: Gotchas when a Postgres function must exactly mirror JS semantics (e.g. slug rules) — verify parity against a real Postgres before shipping
---

When a SQL function must mirror JS logic exactly, three traps produce silent divergence:

1. **Postgres `\s` is locale-dependent.** Under C.UTF-8 it matches only ASCII whitespace; JS `\s`/`String.trim()` also cover NBSP, ogham space, U+2000–200A, U+2028/2029, narrow NBSP, medium math space, ideographic space, and BOM. Build the class explicitly from `chr()` code points instead.
2. **`jsonb ->> 'key'` coerces instead of failing.** Numbers/arrays/objects come back as their text form rather than NULL. Guard with `jsonb_typeof(col -> 'key') IS DISTINCT FROM 'string'` when JS would treat the value as absent.
3. **DDL inside JS template literals** (e.g. initializeTables in db-service.ts) needs every regex backslash doubled and literal backticks escaped, or the SQL Postgres receives differs from what the file shows.

**Why:** a lookup that moved from JS to an indexed SQL column silently diverges for edge-case inputs; mocked-pool unit tests cannot catch it.

**How to apply:** for any SQL that must match JS behavior, run a parity check against a real Postgres with edge-case inputs before shipping.
