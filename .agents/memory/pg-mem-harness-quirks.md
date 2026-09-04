---
name: pg-mem test harness quirks
description: Durable pg-mem behavioral defects that db test wrappers must compensate for.
---

pg-mem enforces unique constraints on `ON CONFLICT ... DO NOTHING` (no duplicate row is written) but misreports the conflicting insert as `rowCount: 1` with a phantom RETURNING row, and direct `memDb.public.none()` does not bind `$n` params (the pg-adapter client's `query` does).

**Why:** Verified by direct repro (Sept 2026): conflict insert reports rows.length=1/rowCount=1 while the table holds exactly 1 row — so claim functions keyed on `rowCount > 0` see a false "inserted" under pg-mem only.

**How to apply:** In pg-mem wrapper clients, probe existence before the insert (via the adapter's param-binding query) and override rowCount/rows from the probe; keep wrapper pass-through regexes matching every table the tested SQL touches — name-prefix traps (a shorter table name not matching a longer one) silently stub queries and mimic logic bugs.
