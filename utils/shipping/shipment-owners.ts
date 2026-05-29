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

// --- Duplicate-purchase guard ---------------------------------------------
//
// Sellers connect their own Shippo account (OAuth) and Shippo bills them
// directly, so the platform enforces no spend cap. Purchased-label history is
// still persisted in the `shipping_labels` table. The in-memory
// `purchasedShipments` set is a short-lived dedupe to prevent racing buys
// of the same shipment before the row commits.

const purchasedShipments = new Set<string>();

export function isShipmentAlreadyPurchased(shipmentId: string): boolean {
  return purchasedShipments.has(shipmentId);
}

export function markShipmentPurchased(shipmentId: string) {
  if (shipmentId) purchasedShipments.add(shipmentId);
}

// Atomically claim a shipment for purchase. Node is single-threaded, so this
// synchronous check-and-set is race-free as long as there is no `await`
// between the check and the set. Returns true if the caller now owns the
// claim, false if the shipment was already claimed/purchased. The caller MUST
// `releaseShipmentClaim` if the purchase ultimately fails, so the seller can
// retry. (Single-instance guard, matching the in-memory dedup model.)
export function claimShipmentForPurchase(shipmentId: string): boolean {
  if (!shipmentId) return false;
  if (purchasedShipments.has(shipmentId)) return false;
  purchasedShipments.add(shipmentId);
  return true;
}

export function releaseShipmentClaim(shipmentId: string) {
  if (shipmentId) purchasedShipments.delete(shipmentId);
}
