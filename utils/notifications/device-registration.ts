import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  isMobileNotificationId,
  isMobilePushToken,
  isNotificationCapability,
  type NotificationDeviceChallengeInput,
  type NotificationDeviceConfirmationInput,
  type NotificationRegistration,
  type NotificationDeviceSummary,
} from "@self-sown/domain";
import type { createNotificationTokenVault } from "./token-crypto";

export class NotificationServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "NotificationServiceError";
  }
}
export function notificationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function requireId(id: string) {
  if (!isMobileNotificationId(id))
    throw new NotificationServiceError(400, "Invalid notification identifier");
}
function requireSeller(seller: string) {
  if (!/^[0-9a-f]{64}$/.test(seller))
    throw new NotificationServiceError(400, "Invalid seller identifier");
}

export function createDeviceRegistrationService(deps: {
  pool: Pool;
  deployment: string;
  vault: ReturnType<typeof createNotificationTokenVault>;
  sendChallenge: (input: {
    token: string;
    challengeId: string;
    nonce: string;
  }) => Promise<void>;
}) {
  const { pool, deployment, vault } = deps;
  async function transaction<T>(
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function lockInstallation(client: PoolClient, installationId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `mobile-install:${deployment}:${installationId}`,
    ]);
  }
  return {
    async requestChallenge(
      seller: string,
      input: NotificationDeviceChallengeInput
    ): Promise<{ challengeId: string }> {
      requireSeller(seller);
      requireId(input.installationId);
      if (
        !isMobilePushToken(input.token) ||
        !["ios", "android"].includes(input.platform)
      )
        throw new NotificationServiceError(400, "Invalid push device");
      const nonce = randomBytes(32).toString("hex");
      const challengeId = await transaction(async (client) => {
        await lockInstallation(client, input.installationId);
        // A newer login intent supersedes old, not-yet-confirmed challenges.
        await client.query(
          "UPDATE mobile_notification_challenges SET consumed_at=now() WHERE deployment=$1 AND installation_id=$2 AND consumed_at IS NULL",
          [deployment, input.installationId]
        );
        const result = await client.query<{ id: string }>(
          `INSERT INTO mobile_notification_challenges
          (seller_pubkey,installation_id,deployment,platform,token_ciphertext,token_digest,nonce_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            seller,
            input.installationId,
            deployment,
            input.platform,
            vault.encrypt(input.token),
            notificationDigest(input.token),
            notificationDigest(nonce),
          ]
        );
        return result.rows[0]!.id;
      });
      try {
        await deps.sendChallenge({ token: input.token, challengeId, nonce });
      } catch {
        await pool.query(
          "UPDATE mobile_notification_challenges SET consumed_at=now() WHERE id=$1",
          [challengeId]
        );
        throw new NotificationServiceError(
          503,
          "Device verification is temporarily unavailable"
        );
      }
      return { challengeId };
    },
    async confirmDevice(
      seller: string,
      input: NotificationDeviceConfirmationInput
    ): Promise<NotificationRegistration> {
      requireSeller(seller);
      requireId(input.installationId);
      requireId(input.challengeId);
      if (!isNotificationCapability(input.nonce))
        throw new NotificationServiceError(400, "Invalid verification nonce");
      const capability = randomBytes(32).toString("hex");
      return transaction(async (client) => {
        // Acquire installation lock before challenge row locks in every path.
        await lockInstallation(client, input.installationId);
        const result = await client.query(
          `SELECT *,expires_at<=now() AS expired FROM mobile_notification_challenges
          WHERE id=$1 AND seller_pubkey=$2 AND installation_id=$3 AND deployment=$4 AND nonce_hash=$5 FOR UPDATE`,
          [
            input.challengeId,
            seller,
            input.installationId,
            deployment,
            notificationDigest(input.nonce),
          ]
        );
        const challenge = result.rows[0];
        if (!challenge)
          throw new NotificationServiceError(404, "Device challenge not found");
        if (challenge.expired || challenge.consumed_at)
          throw new NotificationServiceError(
            409,
            "Device challenge is no longer active"
          );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`mobile-token:${deployment}:${challenge.token_digest}`]
        );
        // The delivered nonce proves possession. Rebinding a token retires its
        // previous installation instead of leaving two active recipients.
        await client.query(
          `UPDATE mobile_push_devices SET enabled=false,generation=generation+1
          WHERE deployment=$1 AND token_digest=$2 AND installation_id<>$3 AND enabled`,
          [deployment, challenge.token_digest, input.installationId]
        );
        const existing = (
          await client.query(
            "SELECT * FROM mobile_push_devices WHERE deployment=$1 AND installation_id=$2 FOR UPDATE",
            [deployment, input.installationId]
          )
        ).rows[0];
        const renewal = Boolean(
          existing?.enabled &&
          existing.seller_pubkey === seller &&
          existing.token_digest === challenge.token_digest
        );
        let row: { id: string; generation: number };
        if (existing) {
          const updated = await client.query(
            `UPDATE mobile_push_devices SET seller_pubkey=$2,platform=$3,
            token_ciphertext=$4,token_digest=$5,revocation_hash=$6,enabled=true,last_seen_at=now(),
            generation=generation+CASE WHEN $7 THEN 0 ELSE 1 END,
            activated_at=CASE WHEN $7 THEN activated_at ELSE now() END
            WHERE id=$1 RETURNING id,generation`,
            [
              existing.id,
              seller,
              challenge.platform,
              challenge.token_ciphertext,
              challenge.token_digest,
              notificationDigest(capability),
              renewal,
            ]
          );
          row = updated.rows[0];
        } else {
          const inserted = await client.query(
            `INSERT INTO mobile_push_devices(seller_pubkey,installation_id,deployment,platform,token_ciphertext,token_digest,revocation_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,generation`,
            [
              seller,
              input.installationId,
              deployment,
              challenge.platform,
              challenge.token_ciphertext,
              challenge.token_digest,
              notificationDigest(capability),
            ]
          );
          row = inserted.rows[0];
        }
        await client.query(
          "UPDATE mobile_notification_challenges SET consumed_at=now() WHERE id=$1",
          [input.challengeId]
        );
        return {
          deviceId: row.id,
          enabled: true,
          generation: row.generation,
          revocationCapability: capability,
        };
      });
    },
    async listDevices(seller: string): Promise<NotificationDeviceSummary[]> {
      requireSeller(seller);
      const rows = (
        await pool.query(
          `SELECT id,platform,enabled,last_seen_at FROM mobile_push_devices
        WHERE seller_pubkey=$1 AND deployment=$2 ORDER BY last_seen_at DESC LIMIT 100`,
          [seller, deployment]
        )
      ).rows;
      return rows.map((row) => ({
        deviceId: row.id,
        platform: row.platform,
        enabled: row.enabled,
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
      }));
    },
    async revokeDevice(
      deviceId: string,
      auth: { seller: string } | { capability: string }
    ): Promise<void> {
      requireId(deviceId);
      if ("seller" in auth) requireSeller(auth.seller);
      else if (!isNotificationCapability(auth.capability))
        throw new NotificationServiceError(404, "Device not found");
      const column = "seller" in auth ? "seller_pubkey" : "revocation_hash";
      const value =
        "seller" in auth ? auth.seller : notificationDigest(auth.capability);
      const result = await pool.query(
        `UPDATE mobile_push_devices SET enabled=false,
        generation=generation+CASE WHEN enabled THEN 1 ELSE 0 END
        WHERE id=$1 AND deployment=$2 AND ${column}=$3 RETURNING id`,
        [deviceId, deployment, value]
      );
      if (result.rowCount === 0)
        throw new NotificationServiceError(404, "Device not found");
    },
    async lookupActivity(
      seller: string,
      activityId: string
    ): Promise<{ messageId: string }> {
      requireSeller(seller);
      requireId(activityId);
      const row = (
        await pool.query(
          `SELECT message_id FROM mobile_notification_activity
        WHERE id=$1 AND recipient_pubkey=$2 AND ingested_at>now()-interval '30 days'`,
          [activityId, seller]
        )
      ).rows[0];
      if (!row) throw new NotificationServiceError(404, "Activity not found");
      return { messageId: row.message_id };
    },
  };
}
