import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "./db-service";
import type { InventorySnapshot } from "@/utils/inventory/live-stock";

export async function ensureInventoryTable(): Promise<void> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await withSchemaDdlLock(client, async (client) => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL,
        seller_pubkey TEXT NOT NULL,
        variant_key TEXT NOT NULL DEFAULT '_default',
        quantity INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'seller_override', 'nostr_sync')),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id, variant_key)
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_product_id ON inventory(product_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_seller_pubkey ON inventory(seller_pubkey);

      CREATE TABLE IF NOT EXISTS inventory_log (
        id SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL,
        variant_key TEXT NOT NULL DEFAULT '_default',
        change_amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        order_id TEXT,
        previous_quantity INTEGER NOT NULL,
        new_quantity INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_log_product_id ON inventory_log(product_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_log_order_id ON inventory_log(order_id);
    `);
    });
  } finally {
    if (client) client.release();
  }
}

let tableReady = false;
async function ensureReady() {
  if (!tableReady) {
    await ensureInventoryTable();
    tableReady = true;
  }
}

export async function getStock(
  productId: string,
  variantKey: string = "_default"
): Promise<{ tracked: boolean; quantity: number }> {
  await ensureReady();
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT quantity FROM inventory WHERE product_id = $1 AND variant_key = $2`,
      [productId, variantKey]
    );
    if (result.rows.length === 0) {
      return { tracked: false, quantity: -1 };
    }
    return { tracked: true, quantity: result.rows[0].quantity };
  } finally {
    if (client) client.release();
  }
}

/** Fold one inventory row into a product's snapshot. */
function addRowToSnapshot(
  snapshot: InventorySnapshot,
  row: { variant_key: string; quantity: number; updated_at: unknown }
) {
  const updatedAt = Number(row.updated_at);
  const stamp = Number.isFinite(updatedAt) ? updatedAt : undefined;
  if (row.variant_key === "_default") {
    snapshot.default_quantity = row.quantity;
    snapshot.default_updated_at = stamp ?? null;
  } else {
    snapshot.variants[row.variant_key] = row.quantity;
    if (stamp !== undefined) {
      snapshot.variant_updated_at = {
        ...snapshot.variant_updated_at,
        [row.variant_key]: stamp,
      };
    }
  }
}

export async function getAllStock(
  productId: string
): Promise<InventorySnapshot> {
  const stock = await getStockForProducts([productId]);
  return stock.get(productId) ?? { default_quantity: null, variants: {} };
}

/**
 * Stock rows for many products in one query. Products with no rows are left
 * out of the map (untracked). Each snapshot carries the unix-second time of the
 * last write per row so callers can apply the newer-wins rule.
 */
export async function getStockForProducts(
  productIds: string[]
): Promise<Map<string, InventorySnapshot>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const stock = new Map<string, InventorySnapshot>();
  if (ids.length === 0) return stock;

  await ensureReady();
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    // updated_at is a plain TIMESTAMP holding session-local wall time, so read
    // it back in that same zone. A bare EXTRACT(EPOCH ...) is off by the zone
    // offset whenever the database is not on UTC.
    const result = await client.query(
      `SELECT product_id, variant_key, quantity,
              EXTRACT(EPOCH FROM (updated_at AT TIME ZONE current_setting('TimeZone')))::bigint AS updated_at
         FROM inventory WHERE product_id = ANY($1::text[])`,
      [ids]
    );
    for (const row of result.rows) {
      let snapshot = stock.get(row.product_id);
      if (!snapshot) {
        snapshot = { default_quantity: null, variants: {} };
        stock.set(row.product_id, snapshot);
      }
      addRowToSnapshot(snapshot, row);
    }
    return stock;
  } finally {
    if (client) client.release();
  }
}

/**
 * Same as getStockForProducts but never throws. Pages and catalogs that only
 * read stock for display use this so a database problem falls back to the
 * listing's own quantities instead of breaking the page.
 */
export async function tryGetStockForProducts(
  productIds: string[]
): Promise<Map<string, InventorySnapshot>> {
  try {
    return await getStockForProducts(productIds);
  } catch (error) {
    console.error("Live stock lookup failed; using listing quantities:", error);
    return new Map();
  }
}

export async function setStock(
  productId: string,
  sellerPubkey: string,
  quantity: number,
  variantKey: string = "_default",
  source: string = "system"
): Promise<{ previous: number; current: number }> {
  await ensureReady();
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT quantity FROM inventory WHERE product_id = $1 AND variant_key = $2`,
      [productId, variantKey]
    );
    const previousQuantity =
      existing.rows.length > 0 ? existing.rows[0].quantity : 0;

    await client.query(
      `INSERT INTO inventory (product_id, seller_pubkey, variant_key, quantity, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (product_id, variant_key) DO UPDATE
       SET quantity = $4, source = $5, seller_pubkey = $2, updated_at = NOW()`,
      [productId, sellerPubkey, variantKey, String(quantity), source]
    );

    await client.query(
      `INSERT INTO inventory_log (product_id, variant_key, change_amount, reason, previous_quantity, new_quantity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        productId,
        variantKey,
        String(quantity - previousQuantity),
        `stock_set_${source}`,
        String(previousQuantity),
        String(quantity),
      ]
    );

    await client.query("COMMIT");
    return { previous: previousQuantity, current: quantity };
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function deductStock(
  productId: string,
  amount: number,
  orderId: string,
  variantKey: string = "_default"
): Promise<{
  success: boolean;
  previous: number;
  current: number;
  error?: string;
}> {
  await ensureReady();
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity FROM inventory WHERE product_id = $1 AND variant_key = $2 FOR UPDATE`,
      [productId, variantKey]
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return { success: true, previous: -1, current: -1 };
    }

    const currentQty = result.rows[0].quantity;

    // Idempotency: if this order already deducted this product/variant, treat the
    // repeat as a successful no-op. The FOR UPDATE lock above serializes concurrent
    // callers so a double-submit / client retry / keepalive resend can't double-
    // deduct the same sale.
    const alreadyDeducted = await client.query(
      `SELECT 1 FROM inventory_log
         WHERE product_id = $1 AND variant_key = $2 AND order_id = $3
           AND reason = 'order_deduction' LIMIT 1`,
      [productId, variantKey, orderId]
    );
    if (alreadyDeducted.rows.length > 0) {
      await client.query("COMMIT");
      return { success: true, previous: currentQty, current: currentQty };
    }

    if (currentQty < amount) {
      await client.query("COMMIT");
      return {
        success: false,
        previous: currentQty,
        current: currentQty,
        error: `Insufficient stock. Available: ${currentQty}, requested: ${amount}`,
      };
    }

    const newQty = currentQty - amount;
    await client.query(
      `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE product_id = $2 AND variant_key = $3`,
      [String(newQty), productId, variantKey]
    );

    await client.query(
      `INSERT INTO inventory_log (product_id, variant_key, change_amount, reason, order_id, previous_quantity, new_quantity)
       VALUES ($1, $2, $3, 'order_deduction', $4, $5, $6)`,
      [
        productId,
        variantKey,
        String(-amount),
        orderId,
        String(currentQty),
        String(newQty),
      ]
    );

    await client.query("COMMIT");
    return { success: true, previous: currentQty, current: newQty };
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function restoreStock(
  productId: string,
  amount: number,
  orderId: string,
  variantKey: string = "_default"
): Promise<{ success: boolean; previous: number; current: number }> {
  await ensureReady();
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity FROM inventory WHERE product_id = $1 AND variant_key = $2 FOR UPDATE`,
      [productId, variantKey]
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return { success: true, previous: -1, current: -1 };
    }

    const currentQty = result.rows[0].quantity;

    // Idempotency: a given order can only restore this product/variant once, so a
    // repeated cancel/refund can't inflate stock. Serialized by the FOR UPDATE lock.
    const alreadyRestored = await client.query(
      `SELECT 1 FROM inventory_log
         WHERE product_id = $1 AND variant_key = $2 AND order_id = $3
           AND reason = 'order_cancellation_restore' LIMIT 1`,
      [productId, variantKey, orderId]
    );
    if (alreadyRestored.rows.length > 0) {
      await client.query("COMMIT");
      return { success: true, previous: currentQty, current: currentQty };
    }

    const newQty = currentQty + amount;

    await client.query(
      `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE product_id = $2 AND variant_key = $3`,
      [String(newQty), productId, variantKey]
    );

    await client.query(
      `INSERT INTO inventory_log (product_id, variant_key, change_amount, reason, order_id, previous_quantity, new_quantity)
       VALUES ($1, $2, $3, 'order_cancellation_restore', $4, $5, $6)`,
      [
        productId,
        variantKey,
        String(amount),
        orderId,
        String(currentQty),
        String(newQty),
      ]
    );

    await client.query("COMMIT");
    return { success: true, previous: currentQty, current: newQty };
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function syncFromNostrEvent(
  productId: string,
  sellerPubkey: string,
  globalQuantity: number | undefined,
  sizeQuantities: Map<string, number> | undefined
): Promise<void> {
  await ensureReady();

  if (globalQuantity !== undefined) {
    await setStock(
      productId,
      sellerPubkey,
      globalQuantity,
      "_default",
      "seller_override"
    );
  }

  if (sizeQuantities) {
    for (const [size, qty] of sizeQuantities.entries()) {
      await setStock(
        productId,
        sellerPubkey,
        qty,
        `size:${size}`,
        "seller_override"
      );
    }
  }
}

export async function checkAvailability(
  productId: string,
  requestedQuantity: number,
  selectedSize?: string
): Promise<{ available: boolean; stock: number; tracked: boolean }> {
  const variantKey = selectedSize ? `size:${selectedSize}` : "_default";
  const { tracked, quantity } = await getStock(productId, variantKey);

  if (!tracked) {
    return { available: true, stock: -1, tracked: false };
  }

  return {
    available: quantity >= requestedQuantity,
    stock: quantity,
    tracked: true,
  };
}

/** Initialize immutable event inventory once. Re-caching an event is not a restock. */
export async function initializeProductEventStock(
  productId: string,
  sellerPubkey: string,
  quantities: Map<string, number>
): Promise<void> {
  if (!quantities.size) return;
  await ensureReady();
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    // Stable ordering prevents deadlocks when duplicate events arrive concurrently.
    for (const [variantKey, quantity] of [...quantities].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > 2147483647
      ) {
        throw new Error(
          "Product stock must be a nonnegative database integer."
        );
      }
      const inserted = await client.query(
        `INSERT INTO inventory(product_id, seller_pubkey, variant_key, quantity, source)
         VALUES ($1,$2,$3,$4,'nostr_sync')
         ON CONFLICT (product_id, variant_key) DO NOTHING RETURNING id`,
        [productId, sellerPubkey, variantKey, quantity]
      );
      if (inserted.rowCount)
        await client.query(
          `INSERT INTO inventory_log(product_id, variant_key, change_amount, reason, previous_quantity, new_quantity)
         VALUES ($1,$2,$3,'stock_set_nostr_sync',0,$3)`,
          [productId, variantKey, quantity]
        );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
