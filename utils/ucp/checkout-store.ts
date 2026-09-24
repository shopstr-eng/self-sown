import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";
import { randomBytes } from "crypto";
import {
  CHECKOUT_STATUSES,
  type CheckoutSessionStatus,
} from "./checkout-status";

/**
 * Persistence + lifecycle for UCP checkout sessions.
 *
 * A checkout session is a THIN, agent-facing wrapper around a real order created
 * by the shared order engine (`utils/ucp/order-service.ts`). It does NOT hold a
 * second copy of payment logic or a parallel order state machine: the row stores
 * the resulting payment descriptor + a human/agent-readable `messages[]`
 * timeline, and its live status is reconciled against the canonical
 * `mcp_orders.payment_status` whenever the session is read. The status names +
 * the reconcile mapping live in the DB-free `checkout-status.ts` so the route,
 * the store, and the unit tests share one source of truth.
 */

export {
  CHECKOUT_STATUSES,
  TERMINAL_CHECKOUT_STATUSES,
  reconcileStatusFromOrder,
  decodeVariantId,
} from "./checkout-status";
export type { CheckoutSessionStatus, DecodedVariant } from "./checkout-status";

/** SQL literal list for the status CHECK constraint, e.g. 'incomplete','…'. */
const STATUS_SQL_LIST = CHECKOUT_STATUSES.map((s) => `'${s}'`).join(",");

/** Severity for a message — agents use this to triage the timeline. */
export type CheckoutMessageSeverity = "info" | "warning" | "error";

export interface CheckoutSessionMessage {
  type: string;
  text: string;
  at: string;
  severity?: CheckoutMessageSeverity;
}

export interface CheckoutSessionRow {
  id: string;
  api_key_id: number | null;
  buyer_pubkey: string;
  seller_pubkey: string;
  product_id: string;
  mcp_order_id: string | null;
  status: CheckoutSessionStatus;
  payment_method: string;
  amount_total: string | number;
  currency: string;
  request: any;
  quote: any;
  payment: any;
  messages: CheckoutSessionMessage[] | null;
  error: string | null;
  /** Machine-readable error code from the order engine (e.g.
   * exchange_rate_unavailable), stamped on pre-order escalation rows. */
  code: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertCheckoutSessionInput {
  /** Pre-generated id; the route mints it up front so the persist-failure
   * fallback can still return a schema-valid session carrying the same id. */
  id?: string;
  buyerPubkey: string;
  sellerPubkey: string;
  productId: string;
  apiKeyId: number | null;
  mcpOrderId: string | null;
  status: CheckoutSessionStatus;
  paymentMethod: string;
  amountTotal: number;
  currency: string;
  request: any;
  quote: any;
  payment: any;
  messages: CheckoutSessionMessage[];
  /** Set on requires_escalation rows so the reason survives for later reads. */
  error?: string | null;
  code?: string | null;
}

let tableReady = false;

export async function initCheckoutSessionsTable(): Promise<void> {
  if (tableReady) return;
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await withSchemaDdlLock(client, async (client) => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS ucp_checkout_sessions (
        id TEXT PRIMARY KEY,
        api_key_id INTEGER REFERENCES mcp_api_keys(id),
        buyer_pubkey TEXT NOT NULL,
        seller_pubkey TEXT NOT NULL,
        product_id TEXT NOT NULL,
        mcp_order_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'incomplete' CHECK (status IN (${STATUS_SQL_LIST})),
        payment_method TEXT NOT NULL,
        amount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        request JSONB,
        quote JSONB,
        payment JSONB,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_buyer ON ucp_checkout_sessions(buyer_pubkey);
      CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_order ON ucp_checkout_sessions(mcp_order_id);
      CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_status ON ucp_checkout_sessions(status);
      -- Pre-order escalation rows persist the engine's machine-readable error
      -- code (e.g. exchange_rate_unavailable) so the reason survives for
      -- agents that look the session up after the fact.
      ALTER TABLE ucp_checkout_sessions ADD COLUMN IF NOT EXISTS code TEXT;
    `);

      // Idempotent migration to the UCP lifecycle status names. A table created by
      // an earlier build of this feature carries the legacy CHECK constraint +
      // legacy status values; drop the constraint, remap any legacy rows, then
      // re-add the constraint with the canonical UCP statuses. (Postgres auto-names
      // a column CHECK as <table>_<column>_check, so the name is deterministic.)
      await client.query(`
      DO $migrate$
      BEGIN
        ALTER TABLE ucp_checkout_sessions
          DROP CONSTRAINT IF EXISTS ucp_checkout_sessions_status_check;
        UPDATE ucp_checkout_sessions SET status = CASE status
          WHEN 'created' THEN 'incomplete'
          WHEN 'requires_payment' THEN 'ready_for_complete'
          WHEN 'pending_seller_confirmation' THEN 'ready_for_complete'
          WHEN 'processing' THEN 'complete_in_progress'
          WHEN 'paid' THEN 'completed'
          WHEN 'failed' THEN 'requires_escalation'
          WHEN 'cancelled' THEN 'canceled'
          WHEN 'expired' THEN 'canceled'
          ELSE status
        END
        WHERE status NOT IN (${STATUS_SQL_LIST});
        ALTER TABLE ucp_checkout_sessions
          ADD CONSTRAINT ucp_checkout_sessions_status_check
          CHECK (status IN (${STATUS_SQL_LIST}));
        ALTER TABLE ucp_checkout_sessions
          ALTER COLUMN status SET DEFAULT 'incomplete';
      END
      $migrate$;
    `);
    });
    tableReady = true;
  } catch (error) {
    console.error("Failed to initialize ucp_checkout_sessions table:", error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export function generateCheckoutSessionId(): string {
  return `ucp_cs_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

export function makeMessage(
  type: string,
  text: string,
  severity?: CheckoutMessageSeverity
): CheckoutSessionMessage {
  return {
    type,
    text,
    at: new Date().toISOString(),
    ...(severity ? { severity } : {}),
  };
}

export async function insertCheckoutSession(
  input: InsertCheckoutSessionInput
): Promise<CheckoutSessionRow> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const id = input.id ?? generateCheckoutSessionId();
    const result = await client.query(
      `INSERT INTO ucp_checkout_sessions
         (id, api_key_id, buyer_pubkey, seller_pubkey, product_id, mcp_order_id,
          status, payment_method, amount_total, currency, request, quote, payment, messages,
          error, code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        id,
        input.apiKeyId,
        input.buyerPubkey,
        input.sellerPubkey,
        input.productId,
        input.mcpOrderId,
        input.status,
        input.paymentMethod,
        input.amountTotal,
        input.currency,
        input.request ? JSON.stringify(input.request) : null,
        input.quote ? JSON.stringify(input.quote) : null,
        input.payment ? JSON.stringify(input.payment) : null,
        JSON.stringify(input.messages || []),
        input.error ?? null,
        input.code ?? null,
      ] as any[]
    );
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

export async function getCheckoutSession(
  id: string
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM ucp_checkout_sessions WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  } finally {
    if (client) client.release();
  }
}

export async function listCheckoutSessions(
  buyerPubkey: string,
  limit: number,
  offset: number
): Promise<CheckoutSessionRow[]> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM ucp_checkout_sessions
       WHERE buyer_pubkey = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [buyerPubkey, limit, offset]
    );
    return result.rows;
  } finally {
    if (client) client.release();
  }
}

export async function updateCheckoutSessionStatus(
  id: string,
  status: CheckoutSessionStatus,
  messages: CheckoutSessionMessage[],
  error: string | null = null
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    // error is set when the transition lands on requires_escalation (so the
    // formatted session explains itself) and cleared on any transition OUT of
    // it (e.g. a failed order that later settles → completed).
    const result = await client.query(
      `UPDATE ucp_checkout_sessions
       SET status = $2, messages = $3, error = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, status, JSON.stringify(messages || []), error]
    );
    return result.rows[0] || null;
  } finally {
    if (client) client.release();
  }
}

/**
 * Fields of an EPHEMERAL (unpersisted) checkout-session response: the 201
 * persist-failure fallback in /api/ucp/checkout/sessions, and the same
 * fallback for the 200 requires_escalation envelope when the escalation row
 * itself could not be persisted. No row exists for these, so there is no row
 * to format — but the published JSON Schema still governs the body, so both
 * the route and the schema-contract test build them through this ONE helper.
 */
export interface EphemeralCheckoutSessionInput {
  id: string;
  status: CheckoutSessionStatus;
  buyerPubkey: string;
  sellerPubkey: string;
  productId: string;
  mcpOrderId?: string | null;
  paymentMethod: string;
  /** Null/undefined when no order total exists (escalation: no order placed). */
  amountTotal?: number | null;
  currency?: string | null;
  payment: Record<string, any> | null;
  messages: CheckoutSessionMessage[];
  error?: string | null;
  /** Machine-readable error code from the order engine (e.g. exchange_rate_unavailable). */
  code?: string | null;
  warning?: string | null;
}

/**
 * Shape an unpersisted session response so it validates against the published
 * checkout-session JSON Schema: id/timestamps/links are minted at response
 * time, and the schema conditionally relaxes amount/currency/payment only for
 * `requires_escalation` (no order → no total or descriptor). The self link
 * may 404 because no row was persisted; the warning/error text says so.
 */
export function formatEphemeralCheckoutSession(
  input: EphemeralCheckoutSessionInput,
  baseUrl: string
) {
  const now = new Date().toISOString();
  return {
    id: input.id,
    status: input.status,
    buyer: { pubkey: input.buyerPubkey },
    seller: { pubkey: input.sellerPubkey },
    productId: input.productId,
    ...(input.mcpOrderId ? { orderId: input.mcpOrderId } : {}),
    paymentMethod: input.paymentMethod,
    ...(input.amountTotal != null ? { amount: input.amountTotal } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    payment: input.payment,
    messages: input.messages,
    ...(input.error ? { error: input.error } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.warning ? { warning: input.warning } : {}),
    createdAt: now,
    updatedAt: now,
    links: {
      self: `${baseUrl}/api/ucp/checkout/sessions/${input.id}`,
      discovery: `${baseUrl}/.well-known/ucp`,
    },
  };
}

export function formatCheckoutSession(
  row: CheckoutSessionRow,
  baseUrl: string
) {
  // A persisted PRE-ORDER escalation row (requires_escalation, no order) has
  // no real total — the column defaults to 0 — so amount is omitted rather
  // than reporting a misleading 0. The schema relaxes amount for exactly
  // this shape and requires the explanatory error instead.
  const preOrderEscalation =
    row.status === "requires_escalation" && !row.mcp_order_id;
  return {
    id: row.id,
    status: row.status,
    buyer: { pubkey: row.buyer_pubkey },
    seller: { pubkey: row.seller_pubkey },
    productId: row.product_id,
    ...(row.mcp_order_id ? { orderId: row.mcp_order_id } : {}),
    paymentMethod: row.payment_method,
    ...(preOrderEscalation ? {} : { amount: Number(row.amount_total) }),
    currency: row.currency,
    payment: row.payment || null,
    ...(row.quote ? { quote: row.quote } : {}),
    messages: row.messages || [],
    ...(row.error ? { error: row.error } : {}),
    ...(row.code ? { code: row.code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links: {
      self: `${baseUrl}/api/ucp/checkout/sessions/${row.id}`,
      discovery: `${baseUrl}/.well-known/ucp`,
    },
  };
}
