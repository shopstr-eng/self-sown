import { getDbPool } from "@/utils/db/db-service";

const TTL_MS = 30 * 60 * 1000;

const sellerCache = new Map<string, { ok: boolean; expiresAt: number }>();
const SELLER_CACHE_TTL_MS = 5 * 60 * 1000;

export async function isListedSeller(pubkey: string): Promise<boolean> {
  if (!pubkey) return false;
  const now = Date.now();
  const cached = sellerCache.get(pubkey);
  if (cached && cached.expiresAt > now) return cached.ok;
  try {
    const pool = getDbPool();
    const result = await pool.query(
      "SELECT 1 FROM product_events WHERE pubkey = $1 LIMIT 1",
      [pubkey]
    );
    const ok = (result.rowCount || 0) > 0;
    sellerCache.set(pubkey, { ok, expiresAt: now + SELLER_CACHE_TTL_MS });
    return ok;
  } catch {
    return false;
  }
}

const owners = new Map<string, { pubkey: string; expiresAt: number }>();

function gc(now: number) {
  for (const [id, entry] of owners) {
    if (entry.expiresAt <= now) owners.delete(id);
  }
}

export function rememberShipmentOwner(shipmentId: string, pubkey: string) {
  if (!shipmentId || !pubkey) return;
  const now = Date.now();
  gc(now);
  owners.set(shipmentId, { pubkey, expiresAt: now + TTL_MS });
}

export function getShipmentOwner(shipmentId: string): string | null {
  if (!shipmentId) return null;
  const now = Date.now();
  const entry = owners.get(shipmentId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    owners.delete(shipmentId);
    return null;
  }
  return entry.pubkey;
}

// --- Financial guardrails -------------------------------------------------
//
// Spend tracking is persisted in the `shipping_labels` table (see
// `getDailySpendForPubkey` in `utils/db/shipping-service`). The in-memory
// `purchasedShipments` set is a short-lived dedupe to prevent racing buys
// of the same shipment before the row commits.

const purchasedShipments = new Set<string>();

export function isShipmentAlreadyPurchased(shipmentId: string): boolean {
  return purchasedShipments.has(shipmentId);
}

export function markShipmentPurchased(shipmentId: string) {
  if (shipmentId) purchasedShipments.add(shipmentId);
}
