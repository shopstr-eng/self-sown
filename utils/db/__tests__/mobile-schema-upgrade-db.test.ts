/** @jest-environment node */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
suite("standalone database upgraded by the mobile API runtime", () => {
  test("initializes message columns before creating indexes and retains cached history", async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(
      "postgres:15-alpine"
    ).start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const previous = process.env.DATABASE_URL;
    try {
      await pool.query(
        readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8")
      );
      // A deployment created by the earlier standalone schema lacks these columns.
      await pool.query(
        "ALTER TABLE message_events DROP COLUMN IF EXISTS is_read CASCADE, DROP COLUMN IF EXISTS order_status CASCADE, DROP COLUMN IF EXISTS order_id CASCADE"
      );
      await pool.query(
        "INSERT INTO message_events(id,pubkey,created_at,kind,tags,content,sig) VALUES($1,$2,1,1059,'[]','opaque','signature')",
        ["a".repeat(64), "b".repeat(64)]
      );
      process.env.DATABASE_URL = container.getConnectionUri();
      await jest.isolateModulesAsync(async () => {
        const db = await import("../db-service");
        try {
          await db.ensureTablesInitialized();
        } finally {
          await db.closeDbPool();
        }
      });
      expect(
        (
          await pool.query(
            "SELECT is_read,order_status,order_id FROM message_events"
          )
        ).rows[0]
      ).toEqual({ is_read: false, order_status: null, order_id: null });
      expect(
        (await pool.query("SELECT * FROM mobile_notification_activity")).rows
      ).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await pool.end();
      await container.stop();
    }
  });
});
