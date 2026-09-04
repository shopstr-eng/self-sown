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
  /**
   * The signed P2PK payout proofs attached to this entry (set at enqueue
   * time or via attachEscrowPayoutPayload). Opaque to this layer — the
   * payout executor (utils/cashu/escrow-payout.ts) validates the shape.
   */
  payoutPayload: unknown | null;
  /**
   * Payee-locked output data (serialized cashu-ts OutputData) persisted
   * AFTER the swap is prepared and BEFORE the mint call. If a retry finds
   * the inputs SPENT, the payout is reconstructed from this via the mint's
   * NUT-09 /restore endpoint instead of paying again.
   */
  preparedOutputs: unknown | null;
}

/** A registered escrow as the payout worker needs it. */
export interface EscrowRegistration {
  escrowId: string;
  buyerPubkey: string;
  sellerPubkey: string;
  orderId: string;
  amountSats: number;
  mintUrl: string;
  arbiterPubkey: string | null;
  expiresAt: Date;
  status: EscrowStatus;
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
  action: EscrowOutboxAction,
  payoutPayload?: unknown
): Promise<{ enqueued: boolean; outboxId: string }> {
  const pool = getDbPool();
  const outboxId = deriveOutboxId(escrowId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock-ordering invariant: the outbox row is always locked BEFORE the
    // registration row, matching finalizeEscrowOutboxEntry (outbox UPDATE →
    // registration UPDATE). An enqueue that locked the registration first
    // deadlocked against an in-flight finalize (AB-BA); taking the existing
    // outbox row's lock here first serializes the race instead. The
    // first-ever enqueue finds no outbox row and takes no lock — nothing can
    // be finalizing a nonexistent entry.
    await client.query(
      `SELECT outbox_id FROM cashu_escrow_outbox WHERE outbox_id = $1 FOR UPDATE`,
      [outboxId]
    );
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
      `INSERT INTO cashu_escrow_outbox (
         outbox_id, escrow_id, action, status, payout_payload
       )
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (outbox_id) DO NOTHING
       RETURNING outbox_id`,
      [
        outboxId,
        escrowId,
        action,
        payoutPayload === undefined ? null : JSON.stringify(payoutPayload),
      ]
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
       -- A release still awaiting the seller's witness is not payable yet;
       -- never claim it (no burned attempts, no claim churn).
       AND (payout_payload->>'stage') IS DISTINCT FROM 'awaiting_seller_witness'
     RETURNING outbox_id, escrow_id, action, status, attempts, payout_payload, prepared_outputs`,
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
    payoutPayload: row.payout_payload ?? null,
    preparedOutputs: row.prepared_outputs ?? null,
  };
}

/**
 * Durably record the prepared payee-locked swap outputs BEFORE the mint
 * call (see executeEscrowPayout). Fenced by the claim token and the
 * 'processing' status: if this worker's claim was reclaimed, the write
 * fails and the payment must not proceed with memory-only outputs.
 */
export async function saveEscrowPreparedOutputs(
  outboxId: string,
  claimToken: string,
  preparedOutputs: unknown
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox
     SET prepared_outputs = $3, updated_at = NOW()
     WHERE outbox_id = $1 AND status = 'processing' AND claim_token = $2`,
    [outboxId, claimToken, JSON.stringify(preparedOutputs)]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Convert a claimed RELEASE whose lock window has expired into a pending
 * REFUND. Fenced by the claim token and conditional on the escrow still
 * being locked and actually expired: an operator (or a slow retry) can no
 * longer strand the buyer by holding an unpayable release row. The
 * seller-signed release payload is discarded — refund proofs must come from
 * the buyer via attachEscrowPayoutPayload.
 */
export async function convertExpiredReleaseToRefund(
  outboxId: string,
  claimToken: string,
  now: Date = new Date()
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox o
     SET action = 'refund',
         status = 'pending',
         payout_payload = NULL,
         prepared_outputs = NULL,
         last_error = 'Release window expired before payout; converted to a refund.',
         updated_at = NOW()
     FROM cashu_escrow_registrations r
     WHERE o.outbox_id = $1
       AND r.escrow_id = o.escrow_id
       AND o.status = 'processing'
       AND o.claim_token = $2
       AND o.action = 'release'
       AND r.status = 'locked'
       AND r.expires_at <= $3`,
    [outboxId, claimToken, now]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Attach (or replace) the signed payout proofs on a PENDING entry. This is
 * how a resolution endpoint supplies the payee-signed P2PK proofs after the
 * entry was enqueued without them (e.g. the expiry sweep enqueues refunds
 * before the buyer has submitted signed refund proofs). The status guard
 * makes the write atomic against a concurrent claim: a worker already
 * processing the entry keeps the payload it claimed with.
 */
export async function attachEscrowPayoutPayload(
  outboxId: string,
  payoutPayload: unknown
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox
     SET payout_payload = $2, updated_at = NOW()
     WHERE outbox_id = $1 AND status = 'pending'`,
    [outboxId, JSON.stringify(payoutPayload)]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Mark a claimed entry done and move the escrow to its terminal state.
 * Requires the fencing token from the claim AND a still-'locked' escrow:
 * a stale worker (claim reclaimed by someone else) or a double finalize
 * both fail instead of clobbering the resolution.
 */
export async function finalizeEscrowOutboxEntry(
  outboxId: string,
  claimToken: string,
  payoutOutputs?: unknown
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE cashu_escrow_outbox
       SET status = 'done', payout_outputs = $3, updated_at = NOW()
       WHERE outbox_id = $1 AND status = 'processing' AND claim_token = $2
       RETURNING escrow_id, action`,
      [
        outboxId,
        claimToken,
        payoutOutputs === undefined ? null : JSON.stringify(payoutOutputs),
      ]
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
export async function recoverStaleEscrowOutboxClaims(options?: {
  staleBefore?: Date;
}): Promise<number> {
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

/**
 * Atomically convert a PENDING release that is still awaiting the seller's
 * witness into a payload-less pending refund once the lock has expired.
 * Post-expiry the buyer owns the funds, so an ignored release approval must
 * never block the buyer's refund — and the worker's claim guard deliberately
 * never claims that stage, so without this conversion the outbox row would
 * deadlock the escrow. Self-guarding (expired + still-locked registration +
 * pending awaiting-witness release only), so callers may invoke it
 * unconditionally and concurrently. Returns true when a conversion happened.
 * A seller-COMPLETED ("ready") release is untouched: the worker converts it
 * at payout time via convertExpiredReleaseToRefund.
 */
export async function convertExpiredAwaitingWitnessReleaseToRefund(
  escrowId: string
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `UPDATE cashu_escrow_outbox o
        SET action = 'refund',
            payout_payload = NULL,
            prepared_outputs = NULL,
            attempts = 0,
            claimed_at = NULL,
            claim_token = NULL,
            updated_at = NOW()
      WHERE o.escrow_id = $1
        AND o.action = 'release'
        AND o.status = 'pending'
        AND o.payout_payload->>'stage' = 'awaiting_seller_witness'
        AND EXISTS (
          SELECT 1 FROM cashu_escrow_registrations r
           WHERE r.escrow_id = o.escrow_id
             AND r.status = 'locked'
             AND r.expires_at <= NOW()
        )`,
    [escrowId]
  );
  return (result.rowCount ?? 0) > 0;
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

/**
 * Every escrow registered by a buyer, newest first, with just enough outbox
 * state for the wallet page to rediscover completed payouts after a browser
 * wipe (served by the buyer-authenticated /api/cashu/escrow/mine endpoint).
 * Read-only; never exposes payout payloads or outputs — payout proofs stay
 * behind the bearer-by-id status endpoint.
 */
export async function listEscrowRegistrationsByBuyer(
  buyerPubkey: string
): Promise<
  Array<{
    escrowId: string;
    orderId: string;
    sellerPubkey: string;
    amountSats: number;
    mintUrl: string;
    expiresAt: Date;
    createdAt: Date;
    status: EscrowRegistration["status"];
    pendingAction: EscrowOutboxAction | null;
    /** True once the payout worker finalized with payee-locked outputs. */
    payoutAvailable: boolean;
  }>
> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT r.escrow_id, r.order_id, r.seller_pubkey, r.amount_sats,
            r.mint_url, r.expires_at, r.created_at, r.status,
            o.action AS outbox_action, o.status AS outbox_status,
            (o.status = 'done'
             -- CASE, not AND-chained terms: PostgreSQL does not guarantee
             -- boolean evaluation order, so jsonb_array_length can otherwise
             -- throw on a non-array payout_outputs and 500 the whole list.
             AND CASE WHEN jsonb_typeof(o.payout_outputs) = 'array'
                      THEN jsonb_array_length(o.payout_outputs) > 0
                      ELSE false END) AS payout_available
     FROM cashu_escrow_registrations r
     LEFT JOIN cashu_escrow_outbox o ON o.escrow_id = r.escrow_id
     WHERE r.buyer_pubkey = $1
     ORDER BY r.created_at DESC`,
    [buyerPubkey]
  );
  return result.rows.map((row) => ({
    escrowId: row.escrow_id,
    orderId: row.order_id,
    sellerPubkey: row.seller_pubkey,
    amountSats: Number(row.amount_sats),
    mintUrl: row.mint_url,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    status: row.status,
    pendingAction:
      row.outbox_status && row.outbox_status !== "done"
        ? row.outbox_action
        : null,
    payoutAvailable: Boolean(row.payout_available),
  }));
}

/** Load a registration for the payout worker. Null when unknown. */
export async function getEscrowRegistration(
  escrowId: string
): Promise<EscrowRegistration | null> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT escrow_id, buyer_pubkey, seller_pubkey, order_id, amount_sats,
            mint_url, arbiter_pubkey, expires_at, status
     FROM cashu_escrow_registrations
     WHERE escrow_id = $1`,
    [escrowId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    escrowId: row.escrow_id,
    buyerPubkey: row.buyer_pubkey,
    sellerPubkey: row.seller_pubkey,
    orderId: row.order_id,
    amountSats: Number(row.amount_sats),
    mintUrl: row.mint_url,
    arbiterPubkey: row.arbiter_pubkey ?? null,
    expiresAt: new Date(row.expires_at),
    status: row.status,
  };
}

/**
 * Outbox state for an escrow, for the buyer-facing status/refund endpoints.
 * Null when no release/refund has ever been enqueued. Read-only. Includes the
 * payout outputs once finalized (payee-P2PK-locked proofs — useless to anyone
 * but the payee); never exposes the payout payload (input proofs).
 */
export async function getEscrowOutboxEntryByEscrowId(
  escrowId: string
): Promise<{
  outboxId: string;
  action: EscrowOutboxAction;
  status: EscrowOutboxStatus;
  payoutOutputs: unknown | null;
  /** Whether the signed payout payload has been attached to the entry. */
  payloadAttached: boolean;
  /** The parsed payout payload (proofs + optional stage), when attached. */
  payoutPayload: { proofs?: unknown; stage?: string } | null;
} | null> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT outbox_id, action, status, payout_outputs, payout_payload, (payout_payload IS NOT NULL) AS payload_attached FROM cashu_escrow_outbox WHERE escrow_id = $1`,
    [escrowId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    outboxId: row.outbox_id,
    action: row.action,
    status: row.status,
    payoutOutputs: row.payout_outputs ?? null,
    payloadAttached: Boolean(row.payload_attached),
    payoutPayload: row.payout_payload ?? null,
  };
}

/**
 * Pending outbox entries for the payout worker to drain, oldest first.
 * Stale 'processing' entries are deliberately excluded — the worker runs
 * recoverStaleEscrowOutboxClaims before draining, which returns them to
 * pending for the NEXT listing (they are then reclaimed with a fresh
 * fencing token at claim time anyway).
 *
 * Entries that have already been attempted back off exponentially
 * (attempts is incremented at each claim): 1min, 2min, 4min, ... capped at
 * 6h, so a permanently-failing entry (e.g. waiting on signed proofs, or a
 * mint refusing) cannot hot-loop the mint every sweep. Fresh entries
 * (attempts = 0) are due immediately.
 */
export async function listPendingEscrowOutboxEntries(
  limit: number = 10,
  now: Date = new Date()
): Promise<Array<{ outboxId: string }>> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT outbox_id FROM cashu_escrow_outbox
     WHERE status = 'pending'
       AND (
         attempts = 0
         OR updated_at
            + LEAST(POWER(2, LEAST(attempts - 1, 10))::int * 60, 21600)
              * INTERVAL '1 second'
            <= $2
       )
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit, now]
  );
  return result.rows.map((row) => ({ outboxId: row.outbox_id }));
}
