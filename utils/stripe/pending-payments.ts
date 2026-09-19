import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";

export type PendingPaymentStatus =
  | "creating"
  | "created"
  | "succeeded"
  | "failed_terminal"
  | "abandoned";

/**
 * Server-owned marker stamped into a multi-seller PaymentIntent's metadata by
 * create-payment-intent. Its presence tells process-transfers that an
 * authoritative split record MUST exist in stripe_pending_payments — a
 * marked intent with a missing/malformed record fails closed instead of
 * falling back to the buyer's browser payload. Absence of the marker
 * identifies genuinely legacy intents created before split persistence.
 */
export const SPLIT_AUTHORITY_METADATA_KEY = "ssSplitAuthority";
export const SPLIT_AUTHORITY_PENDING_RECORD = "pending-record-v1";

export interface PendingPaymentRecord {
  intentRef: string;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  status: PendingPaymentStatus;
  metadata: Record<string, unknown>;
  lastErrorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

let tableInitialized = false;

async function ensureTable(client: PoolClient): Promise<void> {
  if (tableInitialized) return;
  await withSchemaDdlLock(client, async () => {
    await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_pending_payments (
      intent_ref TEXT PRIMARY KEY,
      payment_intent_id TEXT,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error_message TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stripe_pending_payments_status
       ON stripe_pending_payments(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stripe_pending_payments_payment_intent_id
       ON stripe_pending_payments(payment_intent_id)`
    );
    // Claim-token fencing column (additive for pre-existing tables).
    await client.query(`
      ALTER TABLE stripe_pending_payments
        ADD COLUMN IF NOT EXISTS claim_token TEXT
    `);
  });
  tableInitialized = true;
}

/** Thrown when a token-gated write matches zero rows: the attempt's claim
 *  was reclaimed by a newer owner, so the stale owner must abort instead of
 *  overwriting the new owner's record. */
export class PendingPaymentClaimLostError extends Error {
  constructor(intentRef: string) {
    super(
      `Pending payment ${intentRef} claim lost — a newer attempt owns the record`
    );
    this.name = "PendingPaymentClaimLostError";
  }
}

function rowToRecord(row: any): PendingPaymentRecord {
  return {
    intentRef: row.intent_ref,
    paymentIntentId: row.payment_intent_id ?? null,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status as PendingPaymentStatus,
    metadata: row.metadata ?? {},
    lastErrorMessage: row.last_error_message ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function recordPendingPayment(input: {
  intentRef: string;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
}): Promise<{ created: boolean; claimToken: string | null }> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const now = Date.now();
    const claimToken = randomUUID();
    const result = await client.query(
      `INSERT INTO stripe_pending_payments
         (intent_ref, payment_intent_id, amount, currency, status, metadata, created_at, updated_at, claim_token)
       VALUES ($1, NULL, $2, $3, 'creating', $4::jsonb, $5, $5, $6)
       -- RETURNING makes this an atomic attempt claim: concurrent identical
       -- requests get exactly one owner; losers get created:false and must
       -- replay from the record or back off — never create competing Stripe
       -- objects under a shared idempotency key. The returned token fences
       -- all later conditional writes: after a reclaim rotates it, a stale
       -- owner's writes match zero rows.
       ON CONFLICT (intent_ref) DO NOTHING
       RETURNING claim_token`,
      [
        input.intentRef,
        input.amount,
        input.currency,
        JSON.stringify(input.metadata ?? {}),
        now,
        claimToken,
      ]
    );
    return {
      created: result.rows.length > 0,
      claimToken: result.rows[0]?.claim_token ?? null,
    };
  } finally {
    client.release();
  }
}

/**
 * Fenced, atomic takeover of a reclaimable attempt: exactly one of any
 * number of concurrent retries can flip a failed/abandoned (or provably
 * stale "creating") record back to "creating" and become its new owner.
 * Losers get false and must back off (409) — never create competing Stripe
 * objects under the shared idempotency key, which would both mismatch
 * Stripe's first-seen params and race the authoritative allocation metadata.
 */
export async function reclaimPendingPayment(
  intentRef: string,
  staleAfterMs: number
): Promise<string | null> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const now = Date.now();
    // Rotating the claim token fences the previous owner: its conditional
    // writes carry the old token and match zero rows from here on.
    const claimToken = randomUUID();
    const result = await client.query(
      `UPDATE stripe_pending_payments
         SET status = 'creating', last_error_message = NULL,
             updated_at = $2, claim_token = $4
       WHERE intent_ref = $1
         AND (
           status IN ('failed_terminal', 'abandoned')
           OR (status = 'creating' AND updated_at < $3)
         )
       RETURNING claim_token`,
      [intentRef, now, now - staleAfterMs, claimToken]
    );
    return result.rows[0]?.claim_token ?? null;
  } finally {
    client.release();
  }
}

export async function updatePendingPayment(
  intentRef: string,
  patch: Partial<{
    paymentIntentId: string | null;
    status: PendingPaymentStatus;
    lastErrorMessage: string | null;
    metadata: Record<string, unknown>;
    /** When set, the write only lands while this token still owns the
     *  record; a reclaim rotates the token, so a stale owner's write throws
     *  PendingPaymentClaimLostError instead of clobbering the new owner. */
    claimToken: string | null;
  }>
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.paymentIntentId !== undefined) {
      fields.push(`payment_intent_id = $${i++}`);
      values.push(patch.paymentIntentId);
    }
    if (patch.status !== undefined) {
      fields.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.lastErrorMessage !== undefined) {
      fields.push(`last_error_message = $${i++}`);
      values.push(patch.lastErrorMessage);
    }
    if (patch.metadata !== undefined) {
      fields.push(`metadata = $${i++}::jsonb`);
      values.push(JSON.stringify(patch.metadata));
    }
    fields.push(`updated_at = $${i++}`);
    values.push(Date.now());
    let whereClause = `WHERE intent_ref = $${i++}`;
    values.push(intentRef);
    if (patch.claimToken) {
      whereClause += ` AND claim_token = $${i++}`;
      values.push(patch.claimToken);
    }
    const result = await client.query(
      `UPDATE stripe_pending_payments SET ${fields.join(", ")} ${whereClause} RETURNING intent_ref`,
      values
    );
    if (patch.claimToken && result.rows.length === 0) {
      throw new PendingPaymentClaimLostError(intentRef);
    }
  } finally {
    client.release();
  }
}

export async function markPendingPaymentByIntent(
  paymentIntentId: string,
  status: PendingPaymentStatus,
  lastErrorMessage?: string | null
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    await client.query(
      `UPDATE stripe_pending_payments
         SET status = $1, last_error_message = $2, updated_at = $3
       WHERE payment_intent_id = $4`,
      [status, lastErrorMessage ?? null, Date.now(), paymentIntentId]
    );
  } finally {
    client.release();
  }
}

export async function getPendingPayment(
  intentRef: string
): Promise<PendingPaymentRecord | null> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `SELECT * FROM stripe_pending_payments WHERE intent_ref = $1`,
      [intentRef]
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Look up a pending payment by its Stripe PaymentIntent id. Used by
 * process-transfers to recover the authoritative server-computed split
 * details instead of trusting the buyer's browser payload. Returns null only
 * when the row genuinely does not exist (legacy PI created before split
 * persistence, or a pruned terminal row) — DB errors propagate to the caller.
 */
export async function getPendingPaymentByIntentId(
  paymentIntentId: string
): Promise<PendingPaymentRecord | null> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `SELECT * FROM stripe_pending_payments WHERE payment_intent_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [paymentIntentId]
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Best-effort cleanup helper: drop terminal pending-payment records
 * (`succeeded`, `failed_terminal`, `abandoned`) older than `maxAgeMs`.
 * Active rows (`creating`, `created`) are preserved regardless of age so
 * orphan-recovery flows can still see them. Rows carrying multi-seller
 * `sellerSplits` are NEVER pruned: they are the authoritative payout record
 * process-transfers fails closed on, and a succeeded PaymentIntent can reach
 * that route indefinitely (e.g. buyer closed the tab before transfer).
 * Defaults to 30 days.
 */
export async function pruneStripePendingPayments(
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000
): Promise<number> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `DELETE FROM stripe_pending_payments
        WHERE updated_at < $1
          AND status IN ('succeeded', 'failed_terminal', 'abandoned')
          AND (metadata -> 'sellerSplits') IS NULL`,
      [Date.now() - maxAgeMs]
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}

export async function listPendingPayments(
  status: PendingPaymentStatus = "created",
  limit = 100
): Promise<PendingPaymentRecord[]> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const result = await client.query(
      `SELECT * FROM stripe_pending_payments
        WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
      [status, limit]
    );
    return result.rows.map(rowToRecord);
  } finally {
    client.release();
  }
}
