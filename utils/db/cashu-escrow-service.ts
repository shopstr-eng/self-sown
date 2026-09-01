// Durable storage for Cashu escrow registrations and the release/refund
// outbox.
//
// Two tables (bootstrapped in utils/db/db-service.ts initializeTables and
// mirrored in db/schema.sql):
//   - cashu_escrow_registrations: one row per verified buyer commitment.
//     Registration is idempotent on escrow_id (buyer_pubkey:order_id), so a
//     retried or replayed POST can never create a second escrow for the same
//     funds, and a replay with DIFFERENT terms is rejected.
//   - cashu_escrow_outbox: EXACTLY ONE row per escrow (outbox_id IS the
//     escrow id). The first enqueued action wins; an opposite action is
//     rejected, so a release and a refund can never both become payable.
//     Claims carry a fencing token: finalizing or releasing a claim requires
//     the token handed out at claim time, so a worker whose claim went stale
//     (and was reclaimed by another worker) can no longer complete the
//     payout. Stale claims are reclaimable after ESCROW_CLAIM_STALE_MS —
//     crash recovery — and the external payout worker MUST verify proof
//     state at the mint before retrying (the outbox alone cannot make an
//     external mint call exactly-once; see docs/cashu-escrow-threat-model.md).

import { randomUUID } from "crypto";
import type { Event } from "nostr-tools";
import { getDbPool } from "@/utils/db/db-service";
import type { EscrowCommitment } from "@/utils/cashu/escrow-commitment";

/** A processing claim older than this is presumed crashed and reclaimable. */
export const ESCROW_CLAIM_STALE_MS = 15 * 60 * 1000;

export type EscrowStatus = "locked" | "released" | "refunded";
export type EscrowOutboxAction = "release" | "refund";
export type EscrowOutboxStatus = "pending" | "processing" | "done";

export interface EscrowOutboxEntry {
  outboxId: string;
  escrowId: string;
  action: EscrowOutboxAction;
  status: EscrowOutboxStatus;
  attempts: number;
  /** Fencing token — required to finalize or release this claim. */
  claimToken: string;
}

/** One payout action per escrow: the outbox id IS the escrow id. */
export function deriveOutboxId(escrowId: string): string {
  return escrowId;
}

/**
 * Idempotently register a verified escrow commitment.
 * - First call inserts and returns { created: true }.
 * - A replay of the SAME commitment returns { created: false }.
 * - A replay with the same escrow id but different terms throws — the id is
 *   derived from buyer+order, so divergent terms mean a tampered request.
 */
export async function registerEscrowCommitment(
  escrowId: string,
  commitment: EscrowCommitment,
  commitmentEvent: Event
): Promise<{ created: boolean; escrowId: string }> {
  const pool = getDbPool();

  const inserted = await pool.query(
    `INSERT INTO cashu_escrow_registrations (
       escrow_id, buyer_pubkey, seller_pubkey, order_id, amount_sats,
       mint_url, arbiter_pubkey, expires_at, commitment_event, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, 'locked')
     ON CONFLICT (escrow_id) DO NOTHING
     RETURNING escrow_id`,
    [
      escrowId,
      commitment.buyerPubkey,
      commitment.sellerPubkey,
      commitment.orderId,
      commitment.amountSats,
      commitment.mintUrl,
      commitment.arbiterPubkey ?? null,
      commitment.expiresAt,
      JSON.stringify(commitmentEvent),
    ]
  );

  if ((inserted.rowCount || 0) > 0) {
    return { created: true, escrowId };
  }

  // Replay path: confirm the existing row is byte-identical in every field
  // that moves funds; anything else is a tampered re-registration.
  const existing = await pool.query(
    `SELECT seller_pubkey, amount_sats, mint_url,
            arbiter_pubkey, expires_at, status
     FROM cashu_escrow_registrations
     WHERE escrow_id = $1`,
    [escrowId]
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error("Escrow registration conflicted but no row is readable.");
  }
  const existingExpirySeconds = Math.floor(
    new Date(row.expires_at).getTime() / 1000
  );
  const matches =
    row.seller_pubkey === commitment.sellerPubkey &&
    Number(row.amount_sats) === commitment.amountSats &&
    row.mint_url === commitment.mintUrl &&
    (row.arbiter_pubkey ?? undefined) === commitment.arbiterPubkey &&
    existingExpirySeconds === commitment.expiresAt;
  if (!matches) {
    throw new Error(
      "Escrow registration conflict: terms differ from the original commitment."
    );
  }
  return { created: false, escrowId };
}

/**
 * Enqueue the payout action for an escrow. At most ONE action may ever be
 * enqueued per escrow (the outbox row's primary key is the escrow id): a
 * replay of the same action is an idempotent no-op, and the opposite action
 * is rejected — a release and a refund can never both become payable.
 */
export async function enqueueEscrowAction(
  escrowId: string,
  action: EscrowOutboxAction
): Promise<{ enqueued: boolean; outboxId: string }> {
  const pool = getDbPool();
  const outboxId = deriveOutboxId(escrowId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const escrow = await client.query(
      `SELECT status FROM cashu_escrow_registrations
       WHERE escrow_id = $1 FOR UPDATE`,
      [escrowId]
    );
    const status = escrow.rows[0]?.status as EscrowStatus | undefined;
    if (!status) {
      throw new Error("Escrow is not registered.");
    }
    const terminalForAction: Record<EscrowOutboxAction, EscrowStatus> = {
      release: "released",
      refund: "refunded",
    };
    if (status !== "locked" && status !== terminalForAction[action]) {
      throw new Error(
        `Cannot enqueue a ${action}: escrow is already ${status}.`
      );
    }

    const inserted = await client.query(
      `INSERT INTO cashu_escrow_outbox (outbox_id, escrow_id, action, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (outbox_id) DO NOTHING
       RETURNING outbox_id`,
      [outboxId, escrowId, action]
    );
    if ((inserted.rowCount || 0) > 0) {
      await client.query("COMMIT");
      return { enqueued: true, outboxId };
    }

    // Conflict: same action replayed is fine, the opposite action is not.
    const existing = await client.query(
      `SELECT action FROM cashu_escrow_outbox WHERE outbox_id = $1`,
      [outboxId]
    );
    const existingAction = existing.rows[0]?.action;
    if (existingAction && existingAction !== action) {
      throw new Error(
        `Cannot enqueue a ${action}: escrow already has a pending ${existingAction}.`
      );
    }
    await client.query("COMMIT");
    return { enqueued: false, outboxId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically claim a pending outbox entry for processing. Also reclaims
 * entries whose previous claim went stale (process crash mid-payout) — this
 * is the recovery path. Returns null when another worker already holds it.
 * Each successful claim mints a NEW fencing token; any previous token is
 * invalidated, so a crashed-then-replaced worker can no longer finalize.
 */
export async function claimEscrowOutboxEntry(
  outboxId: string,
  options?: { now?: Date; staleBefore?: Date; claimToken?: string }
): Promise<EscrowOutboxEntry | null> {
  const pool = getDbPool();
  const now = options?.now ?? new Date();
  const staleBefore =
    options?.staleBefore ?? new Date(now.getTime() - ESCROW_CLAIM_STALE_MS);
  const claimToken = options?.claimToken ?? randomUUID();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = $3,
         claim_token = $4,
         updated_at = NOW()
     WHERE outbox_id = $1
       AND status <> 'done'
       AND (status = 'pending' OR claimed_at < $2)
     RETURNING outbox_id, escrow_id, action, status, attempts`,
    [outboxId, staleBefore, now, claimToken]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    outboxId: row.outbox_id,
    escrowId: row.escrow_id,
    action: row.action,
    status: row.status,
    attempts: row.attempts,
    claimToken,
  };
}

/**
 * Mark a claimed entry done and move the escrow to its terminal state.
 * Requires the fencing token from the claim AND a still-'locked' escrow:
 * a stale worker (claim reclaimed by someone else) or a double finalize
 * both fail instead of clobbering the resolution.
 */
export async function finalizeEscrowOutboxEntry(
  outboxId: string,
  claimToken: string
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE cashu_escrow_outbox
       SET status = 'done', updated_at = NOW()
       WHERE outbox_id = $1 AND status = 'processing' AND claim_token = $2
       RETURNING escrow_id, action`,
      [outboxId, claimToken]
    );
    const row = updated.rows[0];
    if (!row) {
      throw new Error("Outbox entry is not held by this worker.");
    }
    const terminal: EscrowStatus =
      row.action === "release" ? "released" : "refunded";
    const transitioned = await client.query(
      `UPDATE cashu_escrow_registrations
       SET status = $2, updated_at = NOW()
       WHERE escrow_id = $1 AND status = 'locked'`,
      [row.escrow_id, terminal]
    );
    if ((transitioned.rowCount || 0) === 0) {
      throw new Error("Escrow is already resolved; refusing to re-finalize.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Return a claimed entry to pending after a failed payout attempt so it is
 * retried later. Requires the fencing token. Never deletes the row — the
 * outbox is the durable record. Returns false when the claim is no longer
 * held (e.g. reclaimed by another worker after going stale).
 */
export async function releaseEscrowOutboxClaim(
  outboxId: string,
  claimToken: string,
  errorMessage?: string
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox
     SET status = 'pending',
         last_error = $3,
         updated_at = NOW()
     WHERE outbox_id = $1 AND status = 'processing' AND claim_token = $2`,
    [outboxId, claimToken, errorMessage ?? null]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Crash-recovery sweep: anything claimed longer ago than the stale window is
 * presumed abandoned by a dead process and returned to pending. Returns the
 * number of recovered entries.
 */
export async function recoverStaleEscrowOutboxClaims(
  options?: { staleBefore?: Date }
): Promise<number> {
  const pool = getDbPool();
  const staleBefore =
    options?.staleBefore ?? new Date(Date.now() - ESCROW_CLAIM_STALE_MS);
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox
     SET status = 'pending', updated_at = NOW()
     WHERE status = 'processing' AND claimed_at < $1`,
    [staleBefore]
  );
  return result.rowCount || 0;
}

/** Escrows whose lock expired without a payout — these need refunds. */
export async function listExpiredLockedEscrows(
  now: Date = new Date()
): Promise<Array<{ escrowId: string }>> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT escrow_id FROM cashu_escrow_registrations
     WHERE status = 'locked' AND expires_at < $1`,
    [now]
  );
  return result.rows.map((row) => ({ escrowId: row.escrow_id }));
}
