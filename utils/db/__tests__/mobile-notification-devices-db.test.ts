/** @jest-environment node */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ensureMobileNotificationSchema } from "../mobile-notification-schema";
import { createDeviceRegistrationService } from "../../notifications/device-registration";
import { createNotificationTokenVault } from "../../notifications/token-crypto";

jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
const seller = "a".repeat(64),
  other = "b".repeat(64);
suite("push device ownership", () => {
  let pool: Pool, stop: () => Promise<unknown>;
  const messages: { token: string; challengeId: string; nonce: string }[] = [];
  let service: ReturnType<typeof createDeviceRegistrationService>;
  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(
      "postgres:15-alpine"
    ).start();
    stop = () => container.stop();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      "CREATE TABLE message_events(id text PRIMARY KEY,kind integer,tags jsonb)"
    );
    const client = await pool.connect();
    try {
      await ensureMobileNotificationSchema(client);
    } finally {
      client.release();
    }
    service = createDeviceRegistrationService({
      pool,
      deployment: "test",
      vault: createNotificationTokenVault(
        Buffer.alloc(32, 8).toString("base64")
      ),
      sendChallenge: async (message) => {
        messages.push(message);
      },
    });
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (stop) await stop();
  });
  beforeEach(async () => {
    messages.length = 0;
    await pool.query(
      "TRUNCATE mobile_push_devices,mobile_notification_challenges,mobile_push_deliveries,mobile_notification_activity CASCADE"
    );
  });
  async function challenge(
    owner = seller,
    installationId = randomUUID(),
    token = "ExpoPushToken[fixture]"
  ) {
    const result = await service.requestChallenge(owner, {
      installationId,
      token,
      platform: "ios",
    });
    return {
      installationId,
      challengeId: result.challengeId,
      nonce: messages[messages.length - 1]!.nonce,
    };
  }
  test("stores encrypted token and one-time nonce hash without exposing either in challenge response", async () => {
    const input = await challenge();
    const row = (
      await pool.query("SELECT * FROM mobile_notification_challenges")
    ).rows[0];
    expect(row.token_ciphertext).not.toContain("fixture");
    expect(row.nonce_hash).not.toBe(input.nonce);
    const device = await service.confirmDevice(seller, input);
    expect(device.enabled).toBe(true);
    await expect(service.confirmDevice(seller, input)).rejects.toMatchObject({
      status: 409,
    });
  });
  test("does not consume a nonce for the wrong owner or installation", async () => {
    const input = await challenge();
    await expect(service.confirmDevice(other, input)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.confirmDevice(seller, { ...input, installationId: randomUUID() })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.confirmDevice(seller, { ...input, nonce: "0".repeat(64) })
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.confirmDevice(seller, input)).resolves.toMatchObject({
      enabled: true,
    });
  });
  test("rejects expired challenges", async () => {
    const input = await challenge();
    await pool.query(
      "UPDATE mobile_notification_challenges SET expires_at=now()-interval '1 second'"
    );
    await expect(service.confirmDevice(seller, input)).rejects.toMatchObject({
      status: 409,
    });
  });
  test("renewal retains activation and generation, account switch invalidates the previous capability", async () => {
    const input = await challenge();
    const first = await service.confirmDevice(seller, input);
    const before = (
      await pool.query("SELECT activated_at FROM mobile_push_devices")
    ).rows[0].activated_at;
    const renewed = await service.confirmDevice(
      seller,
      await challenge(seller, input.installationId)
    );
    expect(renewed.generation).toBe(first.generation);
    expect(
      (await pool.query("SELECT activated_at FROM mobile_push_devices")).rows[0]
        .activated_at
    ).toEqual(before);
    const switched = await service.confirmDevice(
      other,
      await challenge(other, input.installationId)
    );
    expect(switched.deviceId).toBe(first.deviceId);
    expect(switched.generation).toBe(first.generation + 1);
    await expect(
      service.revokeDevice(first.deviceId, {
        capability: first.revocationCapability,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.listDevices(seller)).toEqual([]);
    expect(await service.listDevices(other)).toHaveLength(1);
  });
  test("capability can only revoke its own device, idempotently", async () => {
    const first = await service.confirmDevice(seller, await challenge());
    const second = await service.confirmDevice(
      seller,
      await challenge(seller, randomUUID(), "ExpoPushToken[second]")
    );
    await expect(
      service.revokeDevice(second.deviceId, {
        capability: first.revocationCapability,
      })
    ).rejects.toMatchObject({ status: 404 });
    await service.revokeDevice(first.deviceId, {
      capability: first.revocationCapability,
    });
    await service.revokeDevice(first.deviceId, {
      capability: first.revocationCapability,
    });
    expect(
      (await service.listDevices(seller)).find(
        (d) => d.deviceId === first.deviceId
      )?.enabled
    ).toBe(false);
  });
  test("old challenges cannot rebind an installation after a new login starts", async () => {
    const input = await challenge();
    await challenge(other, input.installationId);
    await expect(service.confirmDevice(seller, input)).rejects.toMatchObject({
      status: 409,
    });
  });
  test("activity lookup is seller-scoped and private token data never appears in device metadata", async () => {
    await service.confirmDevice(seller, await challenge());
    const data = await service.listDevices(seller);
    expect(JSON.stringify(data)).not.toContain("fixture");
    expect(JSON.stringify(data)).not.toContain("revocation");
    const activity = (
      await pool.query(
        "INSERT INTO mobile_notification_activity(message_id,recipient_pubkey) VALUES($1,$2) RETURNING id",
        ["c".repeat(64), seller]
      )
    ).rows[0];
    await expect(
      service.lookupActivity(other, activity.id)
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.lookupActivity(seller, activity.id)).resolves.toEqual({
      messageId: "c".repeat(64),
    });
  });
});
