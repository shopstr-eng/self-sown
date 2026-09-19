import { randomUUID } from "crypto";
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
  /**
   * Ownership fencing token — present ONLY when this call created (or
   * reclaimed) the claim. All token-gated completion/release writes carry
   * it: after a stale takeover rotates the token, a resumed previous
   * owner's writes match zero rows instead of clobbering the new owner.
   */
  claimToken: string | null;
}

/** Thrown when a token-gated write matched zero rows: the claim is owned
 *  by a newer attempt (stale takeover rotated the token). */
export class PayoutClaimLostError extends Error {
  constructor(paymentIntentId: string, sellerPubkey: string) {
    super(
      `Payout claim ${paymentIntentId}/${sellerPubkey} is owned by a newer attempt`
    );
    this.name = "PayoutClaimLostError";
  }
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
    // Ownership fencing column (additive for pre-existing tables). NULL on
    // legacy rows: token-gated writes against them simply match no row.
    await client.query(`
      ALTER TABLE stripe_payout_claims
        ADD COLUMN IF NOT EXISTS claim_token TEXT
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
    const claimToken = randomUUID();
    const result = await client.query(
      `INSERT INTO stripe_payout_claims
         (payment_intent_id, seller_pubkey, transfer_id, created_at, claim_token)
       VALUES ($1, $2, NULL, $3, $4)
       ON CONFLICT (payment_intent_id, seller_pubkey) DO NOTHING
       RETURNING claim_token`,
      [paymentIntentId, sellerPubkey, Date.now(), claimToken]
    );
    if (result.rows.length > 0) {
      return { created: true, transferId: null, claimToken };
    }
    // The claim already exists — this caller does NOT own it, so never hand
    // out the row's token (that would defeat the fencing).
    const existing = await client.query(
      `SELECT transfer_id FROM stripe_payout_claims
        WHERE payment_intent_id = $1 AND seller_pubkey = $2`,
      [paymentIntentId, sellerPubkey]
    );
    return {
      created: false,
      transferId: existing.rows[0]?.transfer_id ?? null,
      claimToken: null,
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
  transferId: string,
  claimToken?: string | null
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    // Token-gated when the caller owns the claim: a stale takeover rotates
    // the token, so a resumed previous owner's completion matches ZERO rows
    // — fail loudly (PayoutClaimLostError) instead of silently recording
    // its transfer onto the new owner's claim.
    const result = claimToken
      ? await client.query(
          `UPDATE stripe_payout_claims SET transfer_id = $3
            WHERE payment_intent_id = $1 AND seller_pubkey = $2
              AND claim_token = $4
            RETURNING payment_intent_id`,
          [paymentIntentId, sellerPubkey, transferId, claimToken]
        )
      : await client.query(
          `UPDATE stripe_payout_claims SET transfer_id = $3
            WHERE payment_intent_id = $1 AND seller_pubkey = $2
            RETURNING payment_intent_id`,
          [paymentIntentId, sellerPubkey, transferId]
        );
    if (claimToken && result.rows.length === 0) {
      throw new PayoutClaimLostError(paymentIntentId, sellerPubkey);
    }
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
  sellerPubkey: string,
  claimToken?: string | null
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    // Token-gated when the caller owns the claim: a resumed previous owner
    // must never delete the replacement owner's fresh row.
    await client.query(
      claimToken
        ? `DELETE FROM stripe_payout_claims
            WHERE payment_intent_id = $1 AND seller_pubkey = $2
              AND transfer_id IS NULL AND claim_token = $3`
        : `DELETE FROM stripe_payout_claims
            WHERE payment_intent_id = $1 AND seller_pubkey = $2 AND transfer_id IS NULL`,
      claimToken
        ? [paymentIntentId, sellerPubkey, claimToken]
        : [paymentIntentId, sellerPubkey]
    );
  } finally {
    client.release();
  }
}

/**
 * Release only a PROVABLY stale incomplete claim (crashed owner). A fresh
 * incomplete claim belongs to a live in-flight attempt and must survive —
 * deleting it would let two concurrent attempts both create transfers.
 */
export async function releaseStalePayoutClaim(
  paymentIntentId: string,
  sellerPubkey: string,
  staleAfterMs: number
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `DELETE FROM stripe_payout_claims
         WHERE payment_intent_id = $1 AND seller_pubkey = $2
           AND transfer_id IS NULL AND created_at < $3`,
      [paymentIntentId, sellerPubkey, Date.now() - staleAfterMs]
    );
  } finally {
    client.release();
  }
}

/**
 * Invoice-scoped variants for recurring subscription payouts (webhook
 * invoice.paid). They share the stripe_payout_claims table: invoice ids
 * (in_...) and PaymentIntent ids (pi_...) are prefix-disjoint, so the
 * (id, seller) key space never collides.
 */
export async function claimInvoicePayout(
  invoiceId: string,
  sellerPubkey: string
): Promise<PayoutClaim> {
  return claimPayout(invoiceId, sellerPubkey);
}

export async function completeInvoicePayoutClaim(
  invoiceId: string,
  sellerPubkey: string,
  transferId: string,
  claimToken?: string | null
): Promise<void> {
  return completePayoutClaim(invoiceId, sellerPubkey, transferId, claimToken);
}

export async function releaseInvoicePayoutClaim(
  invoiceId: string,
  sellerPubkey: string,
  claimToken?: string | null
): Promise<void> {
  return releasePayoutClaim(invoiceId, sellerPubkey, claimToken);
}

export async function releaseStaleInvoicePayoutClaim(
  invoiceId: string,
  sellerPubkey: string,
  staleAfterMs: number
): Promise<void> {
  return releaseStalePayoutClaim(invoiceId, sellerPubkey, staleAfterMs);
}
