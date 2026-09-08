/** @jest-environment node */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  ensureMobileNotificationSchema,
  MOBILE_NOTIFICATION_SCHEMA,
} from "../mobile-notification-schema";
import {
  materializeMobilePushDeliveries,
  claimMobilePushDeliveries,
} from "../mobile-notification-service";

jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
const seller = "a".repeat(64);
suite("mobile notification storage", () => {
  let pool: Pool;
  let stop: () => Promise<unknown>;
  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(
      "postgres:15-alpine"
    ).start();
    stop = () => container.stop();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      `CREATE TABLE message_events (id text PRIMARY KEY, kind integer, tags jsonb, pubkey text, created_at bigint, content text, sig text)`
    );
    await pool.query(
      `INSERT INTO message_events VALUES ($1,1059,$2,$3,1,'encrypted','signature')`,
      ["0".repeat(64), JSON.stringify([["p", seller]]), "b".repeat(64)]
    );
    const client = await pool.connect();
    try {
      await ensureMobileNotificationSchema(client);
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (stop) await stop();
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE mobile_push_deliveries, mobile_push_devices, mobile_notification_activity, mobile_notification_challenges CASCADE"
    );
    await pool.query("DELETE FROM message_events WHERE id <> $1", [
      "0".repeat(64),
    ]);
  });
  async function insertMessage(id: string, tags = [["p", seller]]) {
    await pool.query(
      `INSERT INTO message_events VALUES ($1,1059,$2,$3,1,'encrypted','signature') ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content`,
      [id, JSON.stringify(tags), "b".repeat(64)]
    );
  }
  async function device() {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO mobile_push_devices(id,seller_pubkey,installation_id,deployment,platform,token_ciphertext,token_digest,revocation_hash,activated_at)
      VALUES ($1,$2,$3,'test','ios','encrypted-token',$4,'capability-hash',now()-interval '1 minute')`,
      [id, seller, randomUUID(), randomUUID()]
    );
    return id;
  }
  test("runtime and standalone installations use the same schema", () => {
    const standalone = readFileSync(
      resolve(__dirname, "../../../db/schema.sql"),
      "utf8"
    );
    expect(standalone).toContain(MOBILE_NOTIFICATION_SCHEMA.trim());
  });
  test("repeated initialization does not notify historical rows", async () => {
    const client = await pool.connect();
    try {
      await ensureMobileNotificationSchema(client);
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT * FROM mobile_notification_activity")).rows
    ).toHaveLength(0);
  });
  test("first insertion captures one immutable activity despite repeated cache writes", async () => {
    await insertMessage("1".repeat(64));
    const first = (
      await pool.query("SELECT * FROM mobile_notification_activity")
    ).rows[0];
    await insertMessage("1".repeat(64));
    const rows = (
      await pool.query("SELECT * FROM mobile_notification_activity")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].ingested_at).toEqual(first.ingested_at);
    expect(rows[0].recipient_pubkey).toBe(seller);
  });
  test("captures batch inserts while ignoring ambiguous routing", async () => {
    await pool.query(
      `INSERT INTO message_events (id,kind,tags) VALUES ($1,1059,$3),($2,1059,$3)`,
      ["2".repeat(64), "3".repeat(64), JSON.stringify([["p", seller]])]
    );
    await insertMessage("4".repeat(64), [
      ["p", seller],
      ["p", "c".repeat(64)],
    ]);
    expect(
      (await pool.query("SELECT * FROM mobile_notification_activity")).rows
    ).toHaveLength(2);
  });
  test("a rolled-back source write creates no activity", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO message_events(id,kind,tags) VALUES ($1,1059,$2)`,
        ["5".repeat(64), JSON.stringify([["p", seller]])]
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT * FROM mobile_notification_activity")).rows
    ).toHaveLength(0);
  });
  test("reconciliation is idempotent and workers claim disjoint jobs", async () => {
    await device();
    await insertMessage("6".repeat(64));
    await insertMessage("7".repeat(64));
    await Promise.all([
      materializeMobilePushDeliveries(pool, "test"),
      materializeMobilePushDeliveries(pool, "test"),
    ]);
    expect(
      (await pool.query("SELECT * FROM mobile_push_deliveries")).rows
    ).toHaveLength(2);
    const [one, two] = await Promise.all([
      claimMobilePushDeliveries(pool, "test", 1),
      claimMobilePushDeliveries(pool, "test", 1),
    ]);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
    expect(one[0]!.id).not.toBe(two[0]!.id);
  });
  test("disable, binding generation and activation windows invalidate old delivery", async () => {
    const id = await device();
    await insertMessage("8".repeat(64));
    await materializeMobilePushDeliveries(pool, "test");
    await pool.query(
      "UPDATE mobile_push_devices SET enabled=false WHERE id=$1",
      [id]
    );
    expect(await claimMobilePushDeliveries(pool, "test")).toHaveLength(0);
    await pool.query(
      "UPDATE mobile_push_devices SET enabled=true,generation=generation+1,activated_at=now() WHERE id=$1",
      [id]
    );
    await materializeMobilePushDeliveries(pool, "test");
    expect(await claimMobilePushDeliveries(pool, "test")).toHaveLength(0);
  });
  test("expired worker leases recover while old lease owners lose their claim", async () => {
    await device();
    await insertMessage("9".repeat(64));
    await materializeMobilePushDeliveries(pool, "test");
    const first = (await claimMobilePushDeliveries(pool, "test"))[0];
    await pool.query(
      "UPDATE mobile_push_deliveries SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [first!.id]
    );
    const second = (await claimMobilePushDeliveries(pool, "test"))[0];
    expect(second!.id).toBe(first!.id);
    expect(second!.lease_token).not.toBe(first!.lease_token);
  });
});
