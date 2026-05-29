import { getDbPool } from "@/utils/db/db-service";

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

// Shipment ownership and the duplicate-purchase guard now live in the
// cross-instance `shipping_shipment_claims` table. See
// `utils/db/shipping-service.ts` for `rememberShipmentOwner`,
// `getShipmentOwner`, `claimShipmentForPurchase`, `releaseShipmentClaim`, and
// `pruneShipmentClaims`.
