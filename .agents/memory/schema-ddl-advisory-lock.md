---
name: Cross-process runtime DDL coordination
description: Runtime schema DDL must be serialized across processes with pg_advisory_xact_lock in one explicit transaction — session-level locks misfire through transaction poolers
---

Concurrent boot-time schema DDL (central initializer vs lazy per-table ensure helpers, possibly in another process) deadlocks a fresh database (Postgres 40P01). All runtime DDL batches therefore share one advisory lock.

**Why the transaction-scoped form:** the pool factory rewrites Neon URLs to the transaction-pooling `-pooler` endpoint, where consecutive queries on one pooled client can land on different backend sessions — a session-level `pg_advisory_lock` can leak on one backend while failing to cover DDL on another. An explicit BEGIN/COMMIT pins the whole batch to one backend, and `pg_advisory_xact_lock` auto-releases at COMMIT/ROLLBACK or connection death.

**How to apply:** route any new runtime DDL batch through the shared lock; keep it re-entrant (nested ensure calls must not re-open a transaction); never swallow SQL errors inside the lock's transaction (use savepoints for optional migrations — a caught error aborts the whole transaction); publish "schema ready" state only after the commit succeeds. Bootstraps whose promise most callers never await must carry their own rejection handler, or a boot failure crashes under --unhandled-rejections=strict.
