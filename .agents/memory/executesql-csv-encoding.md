---
name: executeSql output is CSV-encoded — decode before writing values back
description: Values returned by the executeSql callback are CSV-quoted (outer quotes + doubled inner quotes); writing them back verbatim corrupts rows.
---

The `executeSql` CodeExecution callback prints result values CSV-encoded: a
text column containing JSON comes back wrapped in double quotes with every
embedded `"` doubled (`""`). Writing that form back verbatim stores corrupt
data (e.g. invalid JSON).

**Why:** a staged-config restore that re-inserted the raw executeSql output
wrote the mangled string into the row; the row failed JSON parsing until
rewritten with the decoded value.

**How to apply:** before reusing a value read via executeSql in a write:
strip header + outer quotes, replace `""` with `"`, then validate
(`JSON.parse` for JSON columns) before writing; escape single quotes by
doubling for the SQL literal. Prefer SQL-native transforms (`jsonb_set`,
`#-`) that never round-trip values through tool output. Note: production
executeSql runs in a read-only transaction — prod writes fail with "cannot
execute UPDATE in a read-only transaction".
