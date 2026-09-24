import { getDbPool } from "@/utils/db/db-service";
import { canActorUpdateMcpOrderStatus } from "./order-status-auth";

export interface CreateOrderInput {
  productId: string;
  quantity: number;
  buyerEmail?: string;
  shippingAddress?: {
    name: string;
    address: string;
    unit?: string;
    city: string;
    postalCode: string;
    stateProvince: string;
    country: string;
  };
}

export interface McpOrder {
  id: number;
  order_id: string;
  api_key_id: number | null;
  buyer_pubkey: string;
  seller_pubkey: string;
  product_id: string;
  product_title: string | null;
  quantity: number;
  amount_total: number;
  currency: string;
  buyer_email: string | null;
  shipping_address: Record<string, string> | null;
  payment_intent_id: string | null;
  payment_status: string;
  order_status: string;
  created_at: string;
  updated_at: string;
}

export async function createMcpOrder(
  orderId: string,
  apiKeyId: number | null,
  buyerPubkey: string,
  sellerPubkey: string,
  productId: string,
  productTitle: string | null,
  quantity: number,
  amountTotal: number,
  currency: string,
  buyerEmail: string | null,
  shippingAddress: Record<string, string> | null,
  paymentIntentId: string | null
): Promise<McpOrder> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO mcp_orders (order_id, api_key_id, buyer_pubkey, seller_pubkey, product_id, product_title, quantity, amount_total, currency, buyer_email, shipping_address, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        orderId,
        apiKeyId,
        buyerPubkey,
        sellerPubkey,
        productId,
        productTitle,
        quantity,
        amountTotal,
        currency,
        buyerEmail,
        shippingAddress ? JSON.stringify(shippingAddress) : null,
        paymentIntentId,
      ] as any[]
    );
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

export async function getMcpOrder(orderId: string): Promise<McpOrder | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM mcp_orders WHERE order_id = $1`,
      [orderId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

export async function listMcpOrders(
  buyerPubkey: string,
  limit: number = 50,
  offset: number = 0
): Promise<McpOrder[]> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM mcp_orders WHERE buyer_pubkey = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [buyerPubkey, limit, offset] as any[]
    );
    return result.rows;
  } finally {
    if (client) client.release();
  }
}

export async function listMcpOrdersAsSeller(
  sellerPubkey: string,
  limit: number = 50,
  offset: number = 0
): Promise<McpOrder[]> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM mcp_orders WHERE seller_pubkey = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [sellerPubkey, limit, offset] as any[]
    );
    return result.rows;
  } finally {
    if (client) client.release();
  }
}

export async function updateMcpOrderPayment(
  orderId: string,
  paymentIntentId: string,
  paymentStatus: string
): Promise<McpOrder | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_orders SET payment_intent_id = $1, payment_status = $2, updated_at = CURRENT_TIMESTAMP WHERE order_id = $3 RETURNING *`,
      [paymentIntentId, paymentStatus, orderId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

export async function updateMcpOrderStatus(
  orderId: string,
  orderStatus: string,
  actorPubkey: string
): Promise<McpOrder | null> {
  const order = await getMcpOrder(orderId);
  if (
    !order ||
    !canActorUpdateMcpOrderStatus(order, orderStatus, actorPubkey)
  ) {
    return null;
  }

  const ownerColumn =
    actorPubkey === order.seller_pubkey ? "seller_pubkey" : "buyer_pubkey";

  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_orders
       SET order_status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $2
         AND ${ownerColumn} = $3
       RETURNING *`,
      [orderStatus, orderId, actorPubkey]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

export async function updateMcpOrderAddress(
  orderId: string,
  buyerPubkey: string,
  newAddress: Record<string, string>
): Promise<McpOrder | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_orders SET shipping_address = $1, updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $2 AND buyer_pubkey = $3 RETURNING *`,
      [JSON.stringify(newAddress), orderId, buyerPubkey] as any[]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
}

/**
 * A Lightning mint quote awaiting settlement, keyed by its MCP order.
 *
 * Persisted in Postgres (mcp_lightning_quotes) — NOT in process memory — so
 * POST /api/mcp/verify-payment can confirm a paid invoice after a redeploy,
 * a restart, or on a different server instance than the one that ran
 * create-order. Rows are deleted when the quote settles (verify-payment);
 * expired-but-unpaid rows are RETAINED for a grace period because a payment
 * in flight at the deadline can still settle (the mint's PAID/ISSUED state
 * is the only settlement evidence — never delete on time alone), and a
 * bounded sweep in savePendingLightningQuote reaps rows a full day past
 * expiry that nobody polls again.
 *
 * Read semantics follow the webhook-accessor rule: a DB error THROWS (the
 * caller's 500 is retryable); null means the quote is genuinely gone
 * (settled, expired, or never existed) and maps to the route's 400.
 */
export interface PendingLightningQuote {
  orderId: string;
  quote: string;
  mintUrl: string;
  amount: number;
  productId: string;
  quantity: number;
  inventoryVariantKey: string;
  // Captured at order-create time so the discount code is marked used ONLY
  // when the invoice actually settles; an abandoned payment leaves the
  // code's max_uses intact.
  discountCode?: string;
  sellerPubkey?: string;
  // ISO 8601 settlement deadline (mint quote expiry / bolt11 tag); null only
  // for rows written before this column existed.
  expiresAt: string | null;
}

interface PendingLightningQuoteRow {
  order_id: string;
  quote: string;
  mint_url: string;
  amount: string | number;
  product_id: string;
  quantity: number;
  inventory_variant_key: string;
  discount_code: string | null;
  seller_pubkey: string | null;
  expires_at: Date | string | null;
}

function rowToPendingLightningQuote(
  row: PendingLightningQuoteRow
): PendingLightningQuote {
  return {
    orderId: row.order_id,
    quote: row.quote,
    mintUrl: row.mint_url,
    amount: Number(row.amount),
    productId: row.product_id,
    quantity: row.quantity,
    inventoryVariantKey: row.inventory_variant_key,
    ...(row.discount_code ? { discountCode: row.discount_code } : {}),
    ...(row.seller_pubkey ? { sellerPubkey: row.seller_pubkey } : {}),
    expiresAt: row.expires_at
      ? new Date(row.expires_at).toISOString()
      : null,
  };
}

export async function savePendingLightningQuote(
  entry: PendingLightningQuote
): Promise<void> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query(
      `INSERT INTO mcp_lightning_quotes (order_id, quote, mint_url, amount, product_id, quantity, inventory_variant_key, discount_code, seller_pubkey, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (order_id) DO UPDATE SET
         quote = EXCLUDED.quote,
         mint_url = EXCLUDED.mint_url,
         amount = EXCLUDED.amount,
         product_id = EXCLUDED.product_id,
         quantity = EXCLUDED.quantity,
         inventory_variant_key = EXCLUDED.inventory_variant_key,
         discount_code = EXCLUDED.discount_code,
         seller_pubkey = EXCLUDED.seller_pubkey,
         expires_at = EXCLUDED.expires_at`,
      [
        entry.orderId,
        entry.quote,
        entry.mintUrl,
        entry.amount,
        entry.productId,
        entry.quantity,
        entry.inventoryVariantKey,
        entry.discountCode ?? null,
        entry.sellerPubkey ?? null,
        entry.expiresAt,
      ] as any[]
    );
    // Bounded-table sweep: a quote a full day past its settlement deadline
    // can never settle, so reap it here (create-order volume is low, and
    // lazy expiry on read alone would leak rows nobody polls again).
    await client.query(
      `DELETE FROM mcp_lightning_quotes WHERE expires_at IS NOT NULL AND expires_at < $1`,
      [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );
  } finally {
    if (client) client.release();
  }
}

export async function getPendingLightningQuote(
  orderId: string
): Promise<PendingLightningQuote | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM mcp_lightning_quotes WHERE order_id = $1`,
      [orderId]
    );
    if (result.rows.length === 0) return null;
    // NOTE: an expired row is still returned. A payment already in flight at
    // the deadline can still settle, and the mint's quote state is the only
    // authority on that — the caller must check the mint FIRST and only use
    // expiresAt to decide what an UNPAID answer means.
    return rowToPendingLightningQuote(result.rows[0]);
  } finally {
    if (client) client.release();
  }
}

/**
 * How long a settlement claim may be held before another poll may take over.
 * Covers a winner that crashes between claiming and finishing its side
 * effects; the winner's own work (a few fast DB writes) takes milliseconds.
 */
export const LIGHTNING_CLAIM_STALE_MS = 60_000;

/**
 * Atomically claim the right to run a settled quote's side effects (mark the
 * order paid, consume the discount code, deduct stock, delete the row).
 * Exactly one concurrent caller wins — on this instance or any other —
 * because the UPDATE's WHERE clause is evaluated under the row lock. Returns
 * the claimed row, or null when another poll holds a fresh claim.
 *
 * Crash-safe: a claim older than `staleMs` may be re-taken, so a winner that
 * dies mid-settlement doesn't strand the order. (If the dead winner already
 * flipped the order to paid, verify-payment's order-status check returns
 * before anyone re-claims, so the discount/stock side effects still can't
 * run twice.)
 */
export async function claimPendingLightningQuote(
  orderId: string,
  staleMs: number = LIGHTNING_CLAIM_STALE_MS
): Promise<PendingLightningQuote | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_lightning_quotes
       SET claimed_at = NOW()
       WHERE order_id = $1
         AND (claimed_at IS NULL OR claimed_at < $2)
       RETURNING *`,
      [orderId, new Date(Date.now() - staleMs).toISOString()]
    );
    if (result.rows.length === 0) return null;
    return rowToPendingLightningQuote(result.rows[0]);
  } finally {
    if (client) client.release();
  }
}

export async function deletePendingLightningQuote(
  orderId: string
): Promise<void> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query(
      `DELETE FROM mcp_lightning_quotes WHERE order_id = $1`,
      [orderId]
    );
  } finally {
    if (client) client.release();
  }
}

export function formatOrderForResponse(order: McpOrder) {
  return {
    orderId: order.order_id,
    productId: order.product_id,
    productTitle: order.product_title,
    quantity: order.quantity,
    amountTotal: parseFloat(String(order.amount_total)),
    currency: order.currency,
    buyerEmail: order.buyer_email,
    shippingAddress: order.shipping_address,
    paymentStatus: order.payment_status,
    orderStatus: order.order_status,
    paymentIntentId: order.payment_intent_id,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}
