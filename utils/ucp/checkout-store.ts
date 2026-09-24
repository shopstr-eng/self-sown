import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";
import { randomBytes } from "crypto";
import {
  CHECKOUT_STATUSES,
  type CheckoutSessionStatus,
} from "./checkout-status";
import type { OrderFlowResult } from "./order-service";

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

/**
 * Atomically claim a pre-order escalation for retry: flips
 * requires_escalation → incomplete in ONE statement so two concurrent retries
 * of the same session can't both reach the order engine and double-create an
 * order. Returns the claimed row, or null when the session was not in
 * requires_escalation (already retried, reconciled away, or never escalated).
 * The caller MUST settle the claim via resolveCheckoutSessionRetry (success),
 * failCheckoutSessionRetry (a PROVABLY pre-order failure — back to
 * requires_escalation), or rescueCheckoutSessionRetry (ambiguous failure:
 * the engine may have created an order, so the session must never become
 * retriable again).
 */
export async function claimCheckoutSessionRetry(
  id: string,
  buyerPubkey: string
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE ucp_checkout_sessions
       SET status = 'incomplete', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND buyer_pubkey = $2 AND status = 'requires_escalation'
       RETURNING *`,
      [id, buyerPubkey]
    );
    return result.rows[0] || null;
  } finally {
    if (client) client.release();
  }
}

/** Fields written when a retry succeeds and the session leaves escalation. */
export interface ResolveCheckoutSessionRetryInput {
  status: CheckoutSessionStatus;
  messages: CheckoutSessionMessage[];
  payment: Record<string, any> | null;
  quote: Record<string, any> | null;
  mcpOrderId: string | null;
  amountTotal: number;
  currency: string;
  paymentMethod: string;
}

/**
 * Settle a claimed retry that produced an order/payment descriptor: record the
 * new order, descriptor, total, and attempted payment method, and clear the
 * escalation error/code. The WHERE status='incomplete' guard fences the write
 * to sessions this process actually claimed.
 */
export async function resolveCheckoutSessionRetry(
  id: string,
  input: ResolveCheckoutSessionRetryInput
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE ucp_checkout_sessions
       SET status = $2, messages = $3, payment = $4, quote = $5,
           mcp_order_id = $6, amount_total = $7, currency = $8,
           payment_method = $9, error = NULL, code = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'incomplete'
       RETURNING *`,
      [
        id,
        input.status,
        JSON.stringify(input.messages || []),
        input.payment ? JSON.stringify(input.payment) : null,
        input.quote ? JSON.stringify(input.quote) : null,
        input.mcpOrderId,
        input.amountTotal,
        input.currency,
        input.paymentMethod,
      ] as any[]
    );
    return result.rows[0] || null;
  } finally {
    if (client) client.release();
  }
}

/**
 * Settle a claimed retry that did NOT produce an order: the session goes back
 * to requires_escalation with the timeline and the latest error/code (the
 * engine's fresh escalation reason on a repeat escalation, or the previous
 * reason preserved by the caller on a hard validation failure).
 */
export async function failCheckoutSessionRetry(
  id: string,
  messages: CheckoutSessionMessage[],
  error: string | null,
  code: string | null,
  paymentMethod: string
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE ucp_checkout_sessions
       SET status = 'requires_escalation', messages = $2, error = $3,
           code = $4, payment_method = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'incomplete'
       RETURNING *`,
      [id, JSON.stringify(messages || []), error, code, paymentMethod]
    );
    return result.rows[0] || null;
  } finally {
    if (client) client.release();
  }
}

/** Fields written when a claimed retry's outcome is ambiguous or unrecorded. */
export interface RescueCheckoutSessionRetryInput {
  /** The order the engine created before the failure/persist gap, when known.
   * Attached so read-time reconciliation can recover the session AND so the
   * retry route's post-order guard permanently blocks a second attempt. */
  mcpOrderId: string | null;
  payment?: Record<string, any> | null;
  quote?: Record<string, any> | null;
  amountTotal?: number;
  currency?: string;
  paymentMethod?: string;
  messages: CheckoutSessionMessage[];
  error: string | null;
  code: string | null;
}

/**
 * Settle a claimed retry whose outcome is AMBIGUOUS: the engine may already
 * have created an order/payment (every payment initializer can throw after
 * createMcpOrder) or the success write failed after the order was placed. In
 * either case the session must NEVER return to a retriable pre-order
 * escalation — that would let a later retry place a second order.
 *
 * Deliberately STATUS-PRESERVING: during a claimed retry no code path sets
 * requires_escalation (read-time reconcile and /complete both need an
 * mcp_order_id the row doesn't have yet), so leaving status alone guarantees
 * the session stays non-retriable, while the attached order id lets GET
 * reconcile it against the canonical mcp_orders.payment_status on next read.
 */
export async function rescueCheckoutSessionRetry(
  id: string,
  input: RescueCheckoutSessionRetryInput
): Promise<CheckoutSessionRow | null> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE ucp_checkout_sessions
       SET mcp_order_id = COALESCE($2, mcp_order_id),
           payment = COALESCE($3, payment),
           quote = COALESCE($4, quote),
           amount_total = COALESCE($5, amount_total),
           currency = COALESCE($6, currency),
           payment_method = COALESCE($7, payment_method),
           messages = $8, error = $9, code = $10,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [
        id,
        input.mcpOrderId,
        input.payment ? JSON.stringify(input.payment) : null,
        input.quote ? JSON.stringify(input.quote) : null,
        input.amountTotal ?? null,
        input.currency ?? null,
        input.paymentMethod ?? null,
        JSON.stringify(input.messages || []),
        input.error,
        input.code,
      ] as any[]
    );
    return result.rows[0] || null;
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

/**
 * Retention for dead PRE-ORDER escalation rows.
 *
 * Every failed checkout that hits a recoverable pre-order problem (e.g. a sats
 * payment on a fiat-priced product with no live exchange rate) persists a
 * `requires_escalation` row with no order attached. Most are never retried, so
 * without a bound the table (and the per-key session list) grows forever.
 *
 * Policy: a pre-order escalation row is deleted once it has gone
 * ESCALATION_SESSION_TTL_MS without an update. The clock is `updated_at`, not
 * `created_at`, on purpose — every retry attempt (failCheckoutSessionRetry)
 * refreshes it, so only sessions the agent has truly abandoned expire; an
 * actively-retried session lives as long as it keeps being retried.
 *
 * Only rows with `mcp_order_id IS NULL` are pruned: a POST-order escalation
 * references a real order whose payment may still need attention, so it must
 * never be aged out. Active and completed sessions are untouched.
 *
 * Because expiry is enforced by DELETION, reads stay consistent: an expired
 * row 404s on GET /sessions/[id] and is absent from GET /sessions — both
 * behave exactly as if the session never persisted. Callers that want the
 * schedule see it here; the prune runs opportunistically from the sessions
 * route (see maybePruneExpiredCheckoutEscalations).
 */
export const ESCALATION_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Prune at most once per hour per process — the DELETE is a full-table
 * status/index scan, so it must not run on every request. */
const ESCALATION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastEscalationPruneAt = 0;

/**
 * Delete expired pre-order escalation rows. Best-effort (mirrors
 * cleanupExpiredRateLimitCounters): a prune failure must never break checkout,
 * so DB errors are logged and reported as 0 deletions rather than thrown.
 * Returns the number of rows deleted.
 */
export async function pruneExpiredCheckoutEscalations(
  now: Date = new Date()
): Promise<number> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `DELETE FROM ucp_checkout_sessions
       WHERE status = 'requires_escalation'
         AND mcp_order_id IS NULL
         AND updated_at < $1`,
      [new Date(now.getTime() - ESCALATION_SESSION_TTL_MS)]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error("Failed to prune expired checkout escalations:", error);
    return 0;
  } finally {
    if (client) client.release();
  }
}

/**
 * Fire-and-forget, interval-throttled prune entry point for request paths.
 * Never throws and never blocks the response.
 */
export function maybePruneExpiredCheckoutEscalations(
  now: number = Date.now()
): void {
  if (now - lastEscalationPruneAt < ESCALATION_PRUNE_INTERVAL_MS) return;
  lastEscalationPruneAt = now;
  void pruneExpiredCheckoutEscalations(new Date(now));
}

/** Test-only: reset the prune throttle so each test starts unthrottled. */
export function resetCheckoutEscalationPruneThrottleForTests(): void {
  lastEscalationPruneAt = 0;
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
 * Translate the neutral order-engine result into the session's status, payment
 * descriptor, and opening timeline. Cashu settles synchronously, so the session
 * is already `completed`; every other method has the payment descriptor ready
 * and the buyer/agent an action to take, so it opens `ready_for_complete` and is
 * driven to `completed` via POST …/complete (or read-time reconciliation).
 *
 * Shared by session creation (POST /api/ucp/checkout/sessions) and escalation
 * retry (POST …/sessions/[id]/retry); the retry route drops the
 * `session_created` opening message and records a `session_retried` entry
 * instead, so the timeline reflects ONE continued session.
 */
export function describeResult(result: OrderFlowResult): {
  status: CheckoutSessionStatus;
  payment: Record<string, any>;
  mcpOrderId: string | null;
  amountTotal: number;
  currency: string;
  messages: CheckoutSessionMessage[];
} {
  const created = makeMessage("session_created", "Checkout session created.");

  if (result.kind === "lightning") {
    return {
      status: "ready_for_complete",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "lightning",
        bolt11: result.bolt11,
        quoteId: result.quoteId,
        amount: result.amountSats,
        currency: "sats",
        mintUrl: result.mintUrl,
        verifyUrl: "/api/mcp/verify-payment",
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Pay the Lightning invoice, then it will confirm automatically."
        ),
      ],
    };
  }

  if (result.kind === "cashu") {
    return {
      status: "completed",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "cashu",
        amount: result.tokenAmount,
        required: result.requiredAmount,
        change: result.change,
        status: "paid",
      },
      messages: [
        created,
        makeMessage("completed", "Cashu token redeemed. Order confirmed."),
      ],
    };
  }

  if (result.kind === "fiat") {
    return {
      status: "ready_for_complete",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "fiat",
        selectedMethod: result.selectedMethod,
        availableMethods: result.fiatOptions,
        amount: result.amount,
        currency: result.currency,
        sellerContact: result.sellerContact,
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Send fiat payment to the seller using the details provided; the seller confirms receipt."
        ),
      ],
    };
  }

  if (result.kind === "subscription") {
    return {
      status: "ready_for_complete",
      mcpOrderId: null,
      amountTotal: result.recurringAmount,
      currency: result.currency,
      payment: {
        method: "stripe",
        type: "subscription",
        subscriptionId: result.subscriptionId,
        frequency: result.frequency,
        clientSecret: result.clientSecret,
        customerId: result.customerId,
        connectedAccountId: result.connectedAccountId,
        recurringAmount: result.recurringAmount,
        currency: result.currency,
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Confirm the first payment with the clientSecret to activate the subscription."
        ),
      ],
    };
  }

  // result.kind === "stripe"
  return {
    status: "ready_for_complete",
    mcpOrderId: result.order.order_id,
    amountTotal: Number(result.order.amount_total),
    currency: result.order.currency,
    payment: {
      method: "stripe",
      amount: result.amount,
      currency: result.currency,
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      connectedAccountId: result.connectedAccountId,
    },
    messages: [
      created,
      makeMessage(
        "ready_for_complete",
        "Confirm the Stripe payment with the clientSecret to complete the order."
      ),
    ],
  };
}

/** A pre-order escalation (no order placed) is the one shape retry accepts. */
function isRetriable(
  status: CheckoutSessionStatus,
  mcpOrderId: string | null | undefined
): boolean {
  return status === "requires_escalation" && !mcpOrderId;
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
      // A retriable escalation advertises its retry action so an agent finds
      // the resume path from the session itself, not from out-of-band docs.
      ...(isRetriable(input.status, input.mcpOrderId)
        ? { retry: `${baseUrl}/api/ucp/checkout/sessions/${input.id}/retry` }
        : {}),
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
      ...(isRetriable(row.status, row.mcp_order_id)
        ? { retry: `${baseUrl}/api/ucp/checkout/sessions/${row.id}/retry` }
        : {}),
    },
  };
}
