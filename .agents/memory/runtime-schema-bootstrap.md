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
bootstrap. It is NOT applied to the hosted dev/prod databases, and this project does
NOT rely on Replit's publish-time schema-diff either.

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
