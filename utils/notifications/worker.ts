import type { Pool } from "pg";
import { verifyEvent, type Event } from "nostr-tools";
import {
  claimMobilePushDeliveries,
  materializeMobilePushDeliveries,
  type MobilePushDelivery,
} from "../db/mobile-notification-service";
import type { createNotificationTokenVault } from "./token-crypto";
import { PushProviderError, type PushProvider } from "./push-provider";

type Dependencies = {
  pool: Pool;
  deployment: string;
  vault: ReturnType<typeof createNotificationTokenVault>;
  provider: PushProvider;
};
const retryMinutes = [1, 5, 15, 60, 180];
const safeCodes = new Set([
  "DeviceNotRegistered",
  "MessageTooBig",
  "MessageRateExceeded",
  "MismatchSenderId",
  "InvalidCredentials",
  "ProviderUnavailable",
  "InvalidProviderResponse",
  "ProviderRejected",
]);
function errorCode(code: string) {
  return safeCodes.has(code) ? code : "ProviderUnavailable";
}

async function sourceIsValid(pool: Pool, job: MobilePushDelivery) {
  const row = (
    await pool.query(
      "SELECT id,kind,tags,pubkey,created_at,content,sig FROM message_events WHERE id=$1",
      [job.message_id]
    )
  ).rows[0];
  if (!row) return false;
  try {
    const event = { ...row, created_at: Number(row.created_at) } as Event;
    if (event.kind !== 1059 || !verifyEvent(event)) return false;
    const recipients = event.tags.filter((tag) => tag[0] === "p");
    return (
      recipients.length === 1 && recipients[0]?.[1] === job.recipient_pubkey
    );
  } catch {
    return false;
  }
}

async function finish(
  pool: Pool,
  job: MobilePushDelivery,
  status: string,
  code: string | null = null
) {
  await pool.query(
    `UPDATE mobile_push_deliveries SET status=$3,last_error=$4,lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1 AND lease_token=$2 AND status='sending'`,
    [job.id, job.lease_token, status, code]
  );
}

// Reserve the rate budget under a device lock, then release it before I/O.
// Reservations count uncertain sends too, so a timeout cannot create a burst.
async function reserve(pool: Pool, job: MobilePushDelivery): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const device = (
      await client.query(
        `SELECT *, now() AS clock FROM mobile_push_devices WHERE id=$1 FOR UPDATE`,
        [job.device_id]
      )
    ).rows[0];
    const owned = (
      await client.query(
        `SELECT id FROM mobile_push_deliveries WHERE id=$1 AND lease_token=$2 AND status='sending' AND lease_expires_at>now() FOR UPDATE`,
        [job.id, job.lease_token]
      )
    ).rowCount;
    if (!owned) {
      await client.query("ROLLBACK");
      return false;
    }
    if (
      !device?.enabled ||
      device.generation !== job.binding_generation ||
      (device.covered_activity_at &&
        device.covered_activity_id !== job.activity_id &&
        new Date(device.covered_activity_at).getTime() >=
          job.ingested_at.getTime())
    ) {
      await client.query(
        `UPDATE mobile_push_deliveries SET status='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
        [job.id]
      );
      await client.query("COMMIT");
      return false;
    }
    const now = (device.clock as Date).getTime();
    const attempts = (device.send_attempts_at as Date[])
      .map((d) => d.getTime())
      .filter((t) => t > now - 3600000)
      .sort((a, b) => a - b);
    const due = Math.max(
      now,
      device.last_sent_at ? new Date(device.last_sent_at).getTime() + 60000 : 0,
      attempts.length >= 12 ? attempts[attempts.length - 12]! + 3600000 : 0
    );
    if (due > now) {
      await client.query(
        `UPDATE mobile_push_deliveries SET status='retry_wait',due_at=$2,attempts=GREATEST(0,attempts-1),lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
        [job.id, new Date(due)]
      );
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `UPDATE mobile_push_devices SET last_sent_at=now(),send_attempts_at=$2 WHERE id=$1`,
      [job.device_id, [...attempts.map((t) => new Date(t)), new Date(now)]]
    );
    // One generic alert covers the inbox through this source's ingestion time.
    // Leave jobs owned by other workers alone; the reservation defers them.
    await client.query(
      `UPDATE mobile_push_deliveries j SET status='superseded' FROM mobile_notification_activity a
      WHERE j.activity_id=a.id AND j.device_id=$1 AND j.binding_generation=$2 AND j.id<>$3
      AND j.status IN ('queued','retry_wait') AND a.ingested_at<=$4`,
      [job.device_id, job.binding_generation, job.id, job.ingested_at]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordAcceptance(
  pool: Pool,
  job: MobilePushDelivery,
  ticketId: string
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM mobile_push_devices WHERE id=$1 FOR UPDATE",
      [job.device_id]
    );
    const saved = await client.query(
      `UPDATE mobile_push_deliveries SET status='accepted',ticket_id=$3,accepted_at=now(),receipt_due_at=now()+interval '15 minutes',lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1 AND lease_token=$2 AND status='sending'`,
      [job.id, job.lease_token, ticketId]
    );
    if (saved.rowCount)
      await client.query(
        `UPDATE mobile_push_devices SET covered_activity_at=$3,covered_activity_id=$4
      WHERE id=$1 AND generation=$2 AND (covered_activity_at IS NULL OR covered_activity_at<=$3)`,
        [
          job.device_id,
          job.binding_generation,
          job.ingested_at,
          job.activity_id,
        ]
      );
    await client.query("COMMIT");
    return saved.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failure(
  pool: Pool,
  job: MobilePushDelivery,
  code: string,
  retryable: boolean,
  retryAfter = 0
) {
  if (code === "DeviceNotRegistered") {
    // Keep the lease predicate in the same transaction as token invalidation.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM mobile_push_devices WHERE id=$1 FOR UPDATE",
        [job.device_id]
      );
      const owned = await client.query(
        `UPDATE mobile_push_deliveries SET status='invalid_device',last_error='DeviceNotRegistered',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 RETURNING id`,
        [job.id, job.lease_token]
      );
      if (owned.rowCount)
        await client.query(
          "UPDATE mobile_push_devices SET enabled=false,generation=generation+1 WHERE id=$1 AND generation=$2 AND enabled",
          [job.device_id, job.binding_generation]
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  const delay = Math.max(
    (retryMinutes[Math.min(Math.max(job.attempts - 1, 0), 4)] ?? 180) * 60,
    retryAfter
  );
  await pool.query(
    `UPDATE mobile_push_deliveries SET status=$3,last_error=$4,due_at=now()+$5*interval '1 second',lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1 AND lease_token=$2`,
    [
      job.id,
      job.lease_token,
      retryable ? "retry_wait" : "failed",
      errorCode(code),
      delay,
    ]
  );
}

async function receipts({ pool, deployment, provider }: Dependencies) {
  const rows = (
    await pool.query<
      MobilePushDelivery & { ticket_id: string; accepted_at: Date }
    >(
      `WITH candidates AS (
    SELECT j.id FROM mobile_push_deliveries j JOIN mobile_push_devices d ON d.id=j.device_id
    WHERE d.deployment=$1 AND j.status='accepted' AND j.receipt_due_at<=now()
    AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now())
    ORDER BY j.receipt_due_at LIMIT 100 FOR UPDATE OF j SKIP LOCKED
  ) UPDATE mobile_push_deliveries j SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'
    FROM candidates c WHERE j.id=c.id RETURNING j.*`,
      [deployment]
    )
  ).rows;
  if (!rows.length) return 0;
  let result: Awaited<ReturnType<PushProvider["receipts"]>>;
  try {
    result = await provider.receipts(rows.map((r) => r.ticket_id));
  } catch {
    result = {};
  }
  for (const job of rows) {
    const receipt = result[job.ticket_id];
    if (receipt?.status === "error") {
      await failure(pool, job, receipt.code, receipt.retryable);
      continue;
    }
    await pool.query(
      `UPDATE mobile_push_deliveries SET status=$3,receipt_due_at=now()+interval '15 minutes',lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1 AND lease_token=$2 AND status='accepted'`,
      [
        job.id,
        job.lease_token,
        receipt?.status === "provider_accepted"
          ? "provider_accepted"
          : Date.now() - job.accepted_at.getTime() > 86400000
            ? "expired"
            : "accepted",
      ]
    );
  }
  return rows.length;
}

export async function processSellerNotifications(deps: Dependencies) {
  const { pool, deployment, provider, vault } = deps;
  const deadline = Date.now() + 40000;
  await pool.query(
    `UPDATE mobile_push_deliveries j SET status='expired',lease_token=NULL,lease_expires_at=NULL
    FROM mobile_notification_activity a,mobile_push_devices d WHERE j.activity_id=a.id AND j.device_id=d.id AND d.deployment=$1
    AND j.status IN ('queued','retry_wait','sending') AND (a.ingested_at<=now()-interval '24 hours' OR NOT d.enabled OR d.generation<>j.binding_generation OR d.last_seen_at<=now()-interval '90 days')`,
    [deployment]
  );
  const checkedReceipts = await receipts(deps);
  const queued = await materializeMobilePushDeliveries(pool, deployment);
  const jobs = await claimMobilePushDeliveries(pool, deployment);
  jobs.sort((a, b) => b.ingested_at.getTime() - a.ingested_at.getTime());
  let accepted = 0;
  for (const job of jobs) {
    if (Date.now() > deadline) break;
    if (!(await sourceIsValid(pool, job))) {
      await finish(pool, job, "failed", "InvalidSource");
      continue;
    }
    let token: string;
    try {
      token = vault.decrypt(job.token_ciphertext);
    } catch {
      await finish(pool, job, "failed", "InvalidTokenCiphertext");
      continue;
    }
    if (!(await reserve(pool, job))) continue;
    try {
      const tickets = await provider.send([
        {
          deviceId: job.device_id,
          token,
          title: "Milk Market",
          body: "New seller activity. Open the app to review.",
          data: {
            version: 1,
            type: "seller_activity",
            activityId: job.activity_id,
          },
        },
      ]);
      const ticket = tickets[0];
      if (tickets.length !== 1 || !ticket || ticket.deviceId !== job.device_id)
        throw new PushProviderError("InvalidProviderResponse", true);
      if (ticket.status === "error") {
        await failure(pool, job, ticket.code, ticket.retryable);
        continue;
      }
      accepted += await recordAcceptance(pool, job, ticket.ticketId);
    } catch (error) {
      await failure(
        pool,
        job,
        error instanceof PushProviderError ? error.code : "ProviderUnavailable",
        error instanceof PushProviderError ? error.retryable : true,
        error instanceof PushProviderError ? error.retryAfterSeconds : 0
      );
    }
  }
  await pool.query(
    "DELETE FROM mobile_notification_challenges WHERE deployment=$1 AND expires_at<now()-interval '24 hours'",
    [deployment]
  );
  await pool.query(
    "DELETE FROM mobile_push_devices WHERE deployment=$1 AND last_seen_at<now()-interval '90 days'",
    [deployment]
  );
  await pool.query(
    "DELETE FROM mobile_notification_activity WHERE ingested_at<now()-interval '30 days'"
  );
  return { queued, claimed: jobs.length, accepted, checkedReceipts };
}
