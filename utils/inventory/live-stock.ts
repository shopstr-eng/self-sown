/**
 * The "newer wins" stock rule.
 *
 * A listing's own quantity tags are the source of truth. Our Postgres
 * `inventory` rows only know about sales made on this marketplace, so they act
 * as a local fallback: a row wins only when it was written after the listing
 * was last published. Pure and dependency-free so the server (SSR, catalog)
 * and the browser (cards, listing page) apply the exact same rule.
 */

/** Stock rows for one product, as returned by inventory-service. */
export interface InventorySnapshot {
  default_quantity: number | null;
  variants: Record<string, number>;
  /** Unix seconds the default row was last written. Absent on older callers. */
  default_updated_at?: number | null;
  /** Unix seconds per variant row. Absent on older callers. */
  variant_updated_at?: Record<string, number>;
}

/** Prefix the inventory table uses for per-size rows. */
export const SIZE_VARIANT_PREFIX = "size:";

/** At or below this many units we show an "Only N left" hint. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Unix seconds from a number or a numeric string. Postgres returns bigint
 * columns such as a cached event's `created_at` as strings, so a strict number
 * check would wrongly treat a real listing time as unknown.
 */
function toUnixSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/**
 * A row is newer when it was written strictly after the listing. A missing
 * timestamp (or listing time) cannot be compared, so the row is trusted; this
 * keeps snapshots built without timestamps behaving as they always did.
 */
function isNewer(rowUpdatedAt: unknown, listingCreatedAt: unknown): boolean {
  const rowSeconds = toUnixSeconds(rowUpdatedAt);
  const listingSeconds = toUnixSeconds(listingCreatedAt);
  if (rowSeconds === undefined || listingSeconds === undefined) return true;
  return rowSeconds > listingSeconds;
}

/**
 * Drop every stock row that is not newer than the listing, so what is left may
 * override the listing's own tags. Returns null when nothing is left.
 */
export function newerStockOnly(
  snapshot: InventorySnapshot | null | undefined,
  listingCreatedAt: number | undefined
): InventorySnapshot | null {
  if (!snapshot) return null;

  const defaultQuantity =
    snapshot.default_quantity !== null &&
    snapshot.default_quantity !== undefined &&
    isNewer(snapshot.default_updated_at, listingCreatedAt)
      ? snapshot.default_quantity
      : null;

  const variants: Record<string, number> = {};
  for (const [key, quantity] of Object.entries(snapshot.variants || {})) {
    if (isNewer(snapshot.variant_updated_at?.[key], listingCreatedAt)) {
      variants[key] = quantity;
    }
  }

  if (defaultQuantity === null && Object.keys(variants).length === 0) {
    return null;
  }
  return { default_quantity: defaultQuantity, variants };
}

interface StockFields {
  createdAt: number;
  quantity?: number;
  sizes?: string[];
  sizeQuantities?: Map<string, number>;
}

/**
 * Apply the rule to a parsed product: newer stock rows replace the listing's
 * `quantity` and per-size quantities. Returns the same object when nothing
 * changes so callers can use it as a stable React dependency.
 */
export function applyStockToProduct<T extends StockFields>(
  product: T,
  snapshot: InventorySnapshot | null | undefined
): T {
  const fresh = newerStockOnly(snapshot, product.createdAt);
  if (!fresh) return product;

  let changed = false;
  let quantity = product.quantity;
  if (
    fresh.default_quantity !== null &&
    fresh.default_quantity !== product.quantity
  ) {
    quantity = fresh.default_quantity;
    changed = true;
  }

  let sizeQuantities = product.sizeQuantities;
  if (sizeQuantities) {
    const next = new Map(sizeQuantities);
    for (const size of sizeQuantities.keys()) {
      const live = fresh.variants[`${SIZE_VARIANT_PREFIX}${size}`];
      if (live !== undefined && live !== next.get(size)) {
        next.set(size, live);
        changed = true;
      }
    }
    sizeQuantities = next;
  }

  if (!changed) return product;
  return { ...product, quantity, sizeQuantities };
}

export interface StockState {
  soldOut: boolean;
  /** Units left when low (1..LOW_STOCK_THRESHOLD), otherwise null. */
  lowStock: number | null;
}

function isCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Sold out / low stock for a product whose quantities already reflect the rule.
 * Untracked products (no quantities at all) are never sold out.
 */
export function getStockState(
  product: Pick<StockFields, "quantity" | "sizes" | "sizeQuantities">
): StockState {
  const { quantity, sizes, sizeQuantities } = product;

  const sizeCounts: number[] = [];
  let sizeUnknown = false;
  for (const size of sizes || []) {
    const count = sizeQuantities?.get(size);
    if (isCount(count)) sizeCounts.push(count);
    else sizeUnknown = true;
  }
  const hasSizeStock = sizeCounts.length > 0 && !sizeUnknown;
  const sizesSoldOut = hasSizeStock && sizeCounts.every((count) => count <= 0);

  const defaultSoldOut = isCount(quantity) && quantity <= 0;
  if (defaultSoldOut || sizesSoldOut) return { soldOut: true, lowStock: null };

  // The scarcest limit is what a buyer can actually get.
  const limits: number[] = [];
  if (isCount(quantity)) limits.push(quantity);
  if (hasSizeStock) {
    limits.push(sizeCounts.reduce((sum, count) => sum + Math.max(count, 0), 0));
  }
  const remaining = limits.length > 0 ? Math.min(...limits) : null;
  return {
    soldOut: false,
    lowStock:
      remaining !== null && remaining <= LOW_STOCK_THRESHOLD ? remaining : null,
  };
}
