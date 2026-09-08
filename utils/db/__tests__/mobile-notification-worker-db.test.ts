/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { finalizeEvent } from "nostr-tools";
import { ensureMobileNotificationSchema } from "../mobile-notification-schema";
import { createNotificationTokenVault } from "../../notifications/token-crypto";
import { processSellerNotifications } from "../../notifications/worker";
import { PushProviderError } from "../../notifications/push-provider";

jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
const seller = "a".repeat(64);
suite("seller notification worker", () => {
  let pool: Pool;
  let stop: () => Promise<unknown>;
  const vault = createNotificationTokenVault(
    Buffer.alloc(32, 7).toString("base64")
  );
  const provider = { send: jest.fn(), receipts: jest.fn() };
  const run = () =>
    processSellerNotifications({ pool, deployment: "test", vault, provider });
  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(
      "postgres:15-alpine"
    ).start();
    stop = () => container.stop();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      "CREATE TABLE message_events(id text PRIMARY KEY, kind integer, tags jsonb, pubkey text, created_at bigint, content text, sig text)"
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
      "TRUNCATE mobile_push_deliveries,mobile_push_devices,mobile_notification_activity,mobile_notification_challenges,message_events CASCADE"
    );
    provider.send.mockReset().mockImplementation(async (messages) =>
      messages.map((m: { deviceId: string }) => ({
        deviceId: m.deviceId,
        status: "accepted",
        ticketId: randomUUID(),
      }))
    );
    provider.receipts.mockReset().mockResolvedValue({});
  });
  async function device() {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO mobile_push_devices(id,seller_pubkey,installation_id,deployment,platform,token_ciphertext,token_digest,revocation_hash,activated_at)
      VALUES($1,$2,$3,'test','ios',$4,$5,'hash',now()-interval '1 minute')`,
      [
        id,
        seller,
        randomUUID(),
        vault.encrypt("ExpoPushToken[fixture]"),
        randomUUID(),
      ]
    );
    return id;
  }
  async function event(tamper = false) {
    const e = finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", seller]],
        content: randomUUID(),
      },
      new Uint8Array(32).fill(15)
    );
    await pool.query(
      "INSERT INTO message_events VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        e.id,
        e.kind,
        JSON.stringify(e.tags),
        e.pubkey,
        e.created_at,
        tamper ? "tampered" : e.content,
        e.sig,
      ]
    );
  }
  test("validates source signatures and exposes only a generic opaque activity", async () => {
    await device();
    await event(true);
    await run();
    expect(provider.send).not.toHaveBeenCalled();
    await event();
    await run();
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0]![0][0];
    expect(sent.title).toBe("Milk Market");
    expect(sent.body).toBe("New seller activity. Open the app to review.");
    expect(Object.keys(sent.data).sort()).toEqual([
      "activityId",
      "type",
      "version",
    ]);
    expect(JSON.stringify(sent)).not.toContain(seller);
  });
  test("overlapping workers coalesce a burst into at most one visible push per device", async () => {
    await device();
    await event();
    await event();
    await event();
    await Promise.all([run(), run()]);
    await run();
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  test("accepted activity covers older burst jobs across later worker runs", async () => {
    await device();
    await event();
    await event();
    await event();
    await run();
    await pool.query(
      "UPDATE mobile_push_devices SET last_sent_at=now()-interval '2 minutes'"
    );
    await pool.query("UPDATE mobile_push_deliveries SET due_at=now()");
    await run();
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  test("rolling hour cap defers sending", async () => {
    const id = await device();
    await event();
    await pool.query(
      "UPDATE mobile_push_devices SET send_attempts_at=ARRAY(SELECT now()-interval '2 minutes' FROM generate_series(1,12)) WHERE id=$1",
      [id]
    );
    await run();
    expect(provider.send).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT status,attempts FROM mobile_push_deliveries"))
        .rows[0]
    ).toMatchObject({ status: "retry_wait", attempts: 0 });
  });
  test("unknown network outcome retries without claiming successful delivery", async () => {
    await device();
    await event();
    provider.send.mockRejectedValue(
      new PushProviderError("ProviderUnavailable", true, 120)
    );
    await run();
    expect(
      (
        await pool.query(
          "SELECT status,last_error,due_at > now()+interval '119 seconds' AS delayed FROM mobile_push_deliveries"
        )
      ).rows[0]
    ).toMatchObject({
      status: "retry_wait",
      last_error: "ProviderUnavailable",
      delayed: true,
    });
  });
  test("invalid tokens disable only their current generation", async () => {
    const id = await device();
    await event();
    provider.send.mockImplementation(async () => [
      {
        deviceId: id,
        status: "error",
        code: "DeviceNotRegistered",
        retryable: false,
      },
    ]);
    await run();
    expect(
      (
        await pool.query(
          "SELECT enabled FROM mobile_push_devices WHERE id=$1",
          [id]
        )
      ).rows[0].enabled
    ).toBe(false);
  });
  test("a receipt is provider acceptance, never proof of user delivery", async () => {
    await device();
    await event();
    await run();
    const job = (
      await pool.query("SELECT ticket_id FROM mobile_push_deliveries")
    ).rows[0];
    provider.receipts.mockResolvedValue({
      [job.ticket_id]: { status: "provider_accepted" },
    });
    await pool.query(
      "UPDATE mobile_push_deliveries SET receipt_due_at=now()-interval '1 second'"
    );
    await run();
    expect(
      (await pool.query("SELECT status FROM mobile_push_deliveries")).rows[0]
        .status
    ).toBe("provider_accepted");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  test("late provider results cannot disable a newly rebound installation", async () => {
    const id = await device();
    await event();
    provider.send.mockImplementation(async () => {
      await pool.query(
        "UPDATE mobile_push_devices SET generation=generation+1 WHERE id=$1",
        [id]
      );
      return [
        {
          deviceId: id,
          status: "error",
          code: "DeviceNotRegistered",
          retryable: false,
        },
      ];
    });
    await run();
    expect(
      (
        await pool.query(
          "SELECT enabled FROM mobile_push_devices WHERE id=$1",
          [id]
        )
      ).rows[0].enabled
    ).toBe(true);
  });
});
