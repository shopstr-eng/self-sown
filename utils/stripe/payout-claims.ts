import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";

/**
 * Server-side payout claims for multi-seller PaymentIntents.
 *
 * Stripe idempotency keys are only guaranteed for ~24h, so they cannot
 * prevent a double payout when process-transfers is retried days later
 * (buyer closed the tab, ops replay, etc.). These claims are the durable,
 * server-owned dedup: one row per (payment_intent_id, seller_pubkey), where
 * the seller pubkey always comes from the authoritative split record — never
 * from the client payload — so a caller cannot mint new claims by inventing
 * pubkeys. Rows are never pruned: a succeeded PaymentIntent can reach the
 * payout route indefinitely.
 */

export interface PayoutClaim {
  created: boolean;
  transferId: string | null;
}

/**
 * Thrown when a transfer id is already recorded on another claim. Adoption
 * of a pre-existing (pre-claims) transfer is globally one-to-one: two
 * sellers may legitimately share a destination account and amount, so the
 * recorded transfer id must be unique across ALL claims or one transfer
 * could be recorded as two sellers' payouts.
 */
export class PayoutClaimConflictError extends Error {
  constructor(transferId: string) {
    super(`Transfer ${transferId} is already recorded on another payout claim`);
    this.name = "PayoutClaimConflictError";
  }
}

let tableInitialized = false;

async function ensureTable(client: PoolClient): Promise<void> {
  if (tableInitialized) return;
  await withSchemaDdlLock(client, async () => {
    await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_payout_claims (
      payment_intent_id TEXT NOT NULL,
      seller_pubkey TEXT NOT NULL,
      transfer_id TEXT,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (payment_intent_id, seller_pubkey)
    )
  `);
    // Globally one-to-one transfer adoption: a recorded transfer id can
    // belong to exactly one claim, across all payment intents (partial
    // index so the many NULL in-flight rows don't collide).
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS stripe_payout_claims_transfer_id_key
      ON stripe_payout_claims (transfer_id) WHERE transfer_id IS NOT NULL
  `);
  });
  tableInitialized = true;
}

/**
 * Atomically claim the payout for one seller of one PaymentIntent.
 * `created: true` means this caller owns the transfer attempt. When the
 * claim already existed, `transferId` carries the completed transfer id if
 * a previous attempt finished; null means a previous attempt crashed between
 * claiming and recording (the caller may retry with the same deterministic
 * Stripe idempotency key).
 */
export async function claimPayout(
  paymentIntentId: string,
  sellerPubkey: string
): Promise<PayoutClaim> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `INSERT INTO stripe_payout_claims
         (payment_intent_id, seller_pubkey, transfer_id, created_at)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (payment_intent_id, seller_pubkey) DO NOTHING
       RETURNING transfer_id`,
      [paymentIntentId, sellerPubkey, Date.now()]
    );
    if (result.rows.length > 0) {
      return { created: true, transferId: null };
    }
    const existing = await client.query(
      `SELECT transfer_id FROM stripe_payout_claims
        WHERE payment_intent_id = $1 AND seller_pubkey = $2`,
      [paymentIntentId, sellerPubkey]
    );
    return {
      created: false,
      transferId: existing.rows[0]?.transfer_id ?? null,
    };
  } finally {
    client.release();
  }
}

/**
 * Record the successful transfer on an owned claim. This is an atomic
 * reservation: the unique index on transfer_id makes adoption globally
 * one-to-one, so a transfer id already recorded on ANY other claim (a
 * concurrent request, or another seller sharing a destination account)
 * raises PayoutClaimConflictError instead of double-recording the payout.
 */
export async function completePayoutClaim(
  paymentIntentId: string,
  sellerPubkey: string,
  transferId: string
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `UPDATE stripe_payout_claims SET transfer_id = $3
        WHERE payment_intent_id = $1 AND seller_pubkey = $2`,
      [paymentIntentId, sellerPubkey, transferId]
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw new PayoutClaimConflictError(transferId);
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Release an owned claim after a failed transfer attempt so a later retry
 * (or ops replay) can try again. Mirrors the webhook claim-release rule:
 * a permanently-deduplicating claim must be released on failure.
 */
export async function releasePayoutClaim(
  paymentIntentId: string,
  sellerPubkey: string
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `DELETE FROM stripe_payout_claims
        WHERE payment_intent_id = $1 AND seller_pubkey = $2 AND transfer_id IS NULL`,
      [paymentIntentId, sellerPubkey]
    );
  } finally {
    client.release();
  }
}
