import type { Pool, QueryResultRow } from "pg";

export interface MobilePushDelivery extends QueryResultRow {
  id: string;
  activity_id: string;
  device_id: string;
  binding_generation: number;
  attempts: number;
  lease_token: string;
  message_id: string;
  recipient_pubkey: string;
  ingested_at: Date;
  token_ciphertext: string;
  platform: "ios" | "android";
}

// Reconcile durable sources directly. No timestamp/sequence checkpoint can
// race past an insertion whose transaction has not committed yet.
export async function materializeMobilePushDeliveries(
  pool: Pool,
  deployment: string,
  limit = 500
): Promise<number> {
  const result = await pool.query(
    `
    INSERT INTO mobile_push_deliveries(activity_id,device_id,binding_generation)
    SELECT a.id,d.id,d.generation
    FROM mobile_notification_activity a
    JOIN mobile_push_devices d ON d.seller_pubkey=a.recipient_pubkey
    WHERE d.deployment=$1 AND d.enabled
      AND d.last_seen_at > now()-interval '90 days'
      AND a.ingested_at >= d.activated_at
      AND a.ingested_at > now()-interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM mobile_push_deliveries j
        WHERE j.activity_id=a.id AND j.device_id=d.id AND j.binding_generation=d.generation)
    ORDER BY a.ingested_at,a.id,d.id
    LIMIT $2 ON CONFLICT DO NOTHING`,
    [deployment, Math.min(Math.max(limit, 1), 500)]
  );
  return result.rowCount ?? 0;
}

export async function claimMobilePushDeliveries(
  pool: Pool,
  deployment: string,
  limit = 100
): Promise<MobilePushDelivery[]> {
  const result = await pool.query<MobilePushDelivery>(
    `
    WITH candidates AS (
      SELECT j.id FROM mobile_push_deliveries j
      JOIN mobile_push_devices d ON d.id=j.device_id
      JOIN mobile_notification_activity a ON a.id=j.activity_id
      WHERE d.deployment=$1 AND d.enabled AND d.generation=j.binding_generation
        AND d.last_seen_at > now()-interval '90 days'
        AND a.ingested_at >= d.activated_at AND a.ingested_at > now()-interval '24 hours'
        AND j.due_at <= now()
        AND (j.status IN ('queued','retry_wait') OR (j.status='sending' AND j.lease_expires_at < now()))
      ORDER BY j.due_at,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED
    ), claimed AS (
      UPDATE mobile_push_deliveries j SET status='sending', attempts=attempts+1,
        lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'
      FROM candidates c WHERE j.id=c.id RETURNING j.*
    )
    SELECT j.id,j.activity_id,j.device_id,j.binding_generation,j.attempts,j.lease_token,
      a.message_id,a.recipient_pubkey,a.ingested_at,d.token_ciphertext,d.platform
    FROM claimed j JOIN mobile_notification_activity a ON a.id=j.activity_id
    JOIN mobile_push_devices d ON d.id=j.device_id`,
    [deployment, Math.min(Math.max(limit, 1), 100)]
  );
  return result.rows;
}
