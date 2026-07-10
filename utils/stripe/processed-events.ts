import type { PoolClient } from "pg";
import { getDbPool } from "@/utils/db/db-service";

let tableInitialized = false;

/**
 * How long a claim may sit in the `processing` state before another worker (or
 * a Stripe retry) is allowed to reclaim it. This is the crash-recovery window:
 * if the process dies after claiming but before finalizing, the event would
 * otherwise stay "claimed" forever and Stripe's retry would be silently
 * deduped. Stripe retries an event for ~3 days, so a short window here means a
 * crashed claim is picked back up on a later retry.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

async function ensureTable(client: PoolClient): Promise<void> {
  if (tableInitialized) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_processed_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      claimed_at BIGINT
    )
  `);
  // Self-migrate deployments whose table predates the lifecycle columns.
  await client.query(
    `ALTER TABLE stripe_processed_events
       ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing'`
  );
  await client.query(
    `ALTER TABLE stripe_processed_events
       ADD COLUMN IF NOT EXISTS claimed_at BIGINT`
  );
  // Pre-migration rows were written under the old "insert == done forever"
  // semantics, so treat any row without a claim timestamp as already finalized.
  // (New claims always set claimed_at, so this only touches legacy rows.)
  await client.query(
    `UPDATE stripe_processed_events
       SET status = 'done'
     WHERE claimed_at IS NULL AND status <> 'done'`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_stripe_processed_events_processed_at
       ON stripe_processed_events(processed_at)`
  );
  tableInitialized = true;
}

/**
 * Atomically claim a Stripe webhook event for processing.
 * Returns `true` when this caller should process the event, `false` when it
 * has already been finalized (`done`) or is being processed by another worker
 * whose claim is still fresh. A `processing` claim older than `STALE_CLAIM_MS`
 * is considered abandoned (crashed worker) and is reclaimed.
 *
 * Callers MUST call `finalizeStripeEvent` after successful processing, or
 * `releaseStripeEvent` on failure so Stripe's retry can reprocess immediately.
 */
export async function claimStripeEvent(
  eventId: string,
  eventType: string
): Promise<boolean> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const now = Date.now();
    const staleBefore = now - STALE_CLAIM_MS;
    const result = await client.query(
      `INSERT INTO stripe_processed_events
         (event_id, event_type, processed_at, status, claimed_at)
       VALUES ($1, $2, $3, 'processing', $3)
       ON CONFLICT (event_id) DO UPDATE
         SET event_type = EXCLUDED.event_type,
             processed_at = EXCLUDED.processed_at,
             claimed_at = EXCLUDED.claimed_at,
             status = 'processing'
       WHERE stripe_processed_events.status <> 'done'
         AND stripe_processed_events.claimed_at IS NOT NULL
         AND stripe_processed_events.claimed_at < $4
       RETURNING event_id`,
      [eventId, eventType, now, staleBefore]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

/**
 * Mark a claimed event as fully processed. After this, the claim is permanent
 * and every future Stripe retry of the same event is deduped. Call this ONLY
 * after the handler has completed successfully.
 */
export async function finalizeStripeEvent(eventId: string): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `UPDATE stripe_processed_events
         SET status = 'done', processed_at = $2
       WHERE event_id = $1`,
      [eventId, Date.now()]
    );
  } finally {
    client.release();
  }
}

/**
 * Release a previously-claimed event so Stripe's retry can reprocess it
 * immediately. Call this when handler logic throws AFTER `claimStripeEvent`
 * succeeded — otherwise the claim would dedup the retry and drop the event.
 */
export async function releaseStripeEvent(eventId: string): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `DELETE FROM stripe_processed_events WHERE event_id = $1`,
      [eventId]
    );
  } finally {
    client.release();
  }
}

/**
 * Best-effort cleanup helper: drop processed-event records older than
 * `maxAgeMs`. Stripe replays events for ~30 days, so default to 45 days.
 */
export async function pruneStripeProcessedEvents(
  maxAgeMs: number = 45 * 24 * 60 * 60 * 1000
): Promise<number> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `DELETE FROM stripe_processed_events WHERE processed_at < $1`,
      [Date.now() - maxAgeMs]
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}
