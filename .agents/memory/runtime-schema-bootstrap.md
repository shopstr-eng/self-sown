---
name: Runtime schema bootstrap (initializeTables vs db/schema.sql)
description: Where DDL for the hosted app actually lives, and why db/schema.sql is not enough.
---

# Runtime schema bootstrap

The hosted app's Postgres schema (dev AND prod) is created/migrated at RUNTIME by
`initializeTables()` in `utils/db/db-service.ts` — a long series of
`CREATE TABLE IF NOT EXISTS` + idempotent guarded `ALTER TABLE ... ADD COLUMN`
(either `ADD COLUMN IF NOT EXISTS` or a `DO $$ ... information_schema.columns ... $$`
existence-guard block). `scripts/post-merge.sh` states this outright.

`db/schema.sql` is a SEPARATE mirror used ONLY for self-host `psql -f db/schema.sql`
bootstrap. It is NOT applied to the hosted dev/prod databases. The app does not RELY on
Replit's publish-time schema-diff, but the publish flow still RUNS it and it can block:
several tables self-create lazily in their own modules (utils/stripe/processed-events.ts,
pending-payments.ts, utils/mcp/auth.ts, utils/ucp/checkout-store.ts, etc.) rather than in
initializeTables(). A lazy table that exists in prod (created by real traffic) but not in
dev (e.g. stripe_processed_events — dev never receives Stripe webhooks) is seen by the
publish diff as "removed", gets paired with an unrelated new-table "add", and forces a
RENAME-or-DROP choice with no ignore option. Both answers corrupt data (rename mislabels
webhook dedup rows AND breaks the new table's inserts — the columns differ; drop erases
permanent dedup claims → replayed webhooks can double-pay). Fix (done 2026-09 for
stripe_processed_events): create the missing table in the DEV database with the module's
own DDL; the diff then sees no removal. Prevention (done 2026-09): every lazily-created
table (stripe_processed_events, stripe_pending_payments, ucp_checkout_sessions, MCP
tables, inventory, email_auth, failed_relay_publishes) is now ALSO created in
initializeTables() — IF NOT EXISTS makes coexistence safe; lazy ensure* functions remain
as no-ops and keep their data migrations. Any NEW lazy table must be registered there
too, or the rename/drop trap returns. Enforcement (2026-09): Jest guard
__tests__/utils/db/central-table-registration.test.ts fs-scans source dirs for CREATE
TABLE and fails if the table isn't also in db-service.ts (dynamic ${} table names are
flagged for manual review). The MCP tables (mcp_api_keys/mcp_orders/mcp_request_proofs)
exist in THREE copies — utils/mcp/auth.ts, db-service.ts initializeTables(), AND
db/schema.sql — which had silently diverged (columns, currency default, permissions
CHECK); reconciled 2026-09 with idempotent ALTER self-migrations in both runtime paths.
Any new MCP column must go in all three copies plus an ALTER.

**Rule:** any new table or column for a hosted feature MUST be added to
`initializeTables()`. Adding it only to `db/schema.sql` means the hosted DBs never get
it, and the endpoint 500s at runtime with `column "X" of relation "Y" does not exist`
(fails closed / silently drops the write).

**Why:** the storefront contact-capture popup broke exactly this way — the `source`
column on `popup_email_captures` (and the table itself) lived only in `db/schema.sql`,
never in `initializeTables()`, so every popup + subscription capture 500'd and dropped
the contact + welcome discount code. Proof it's runtime-init and not publish-diff:
prod had every column that exists only in `initializeTables()`
(`discount_codes.shipping_discount_type`, `scheduled_blog_posts.last_error`,
`stripe_connect_accounts.tax_enabled`) but was missing `source`.

**How to apply:**

- Add `CREATE TABLE IF NOT EXISTS` + a column-existence-guarded migration to
  `initializeTables()`, mirroring `db/schema.sql` (keep the two in sync).
- Apply the same DDL to the DEV database directly (`executeSql`, development is
  writable) so the feature works immediately without a workflow restart.
- Production only picks up the new DDL when its runtime `initializeTables()` runs on
  the next deploy — so the user must RE-PUBLISH to fix prod.
- pg-mem unit tests can exercise the "effective statements" of a `DO` block (pg-mem
  doesn't run plpgsql); real-Postgres testcontainer tests are not agent-runnable.
