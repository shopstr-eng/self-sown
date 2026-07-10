/**
 * Split an exact integer `total` (sats) across keyed recipients in proportion
 * to their raw weights, using the largest-remainder method so the returned
 * amounts ALWAYS sum to `total` exactly (no rounding drift, no burn, no
 * shortfall).
 *
 * Why this exists: the cart mints/swaps a single discounted total (`price`)
 * and must hand every seller their share of THAT amount. Distributing the
 * pre-discount per-seller subtotals instead makes the shares sum to more than
 * was minted, so the ecash swap fails ("insufficient"); distributing less
 * silently burns the difference. Allocating the actually-minted amount here
 * keeps fund splits === minted proofs.
 *
 * Contract:
 *  - Returns a value for every key in `rawByKey` (0 when total is 0).
 *  - Sum of returned values === Math.max(0, floor(total)) whenever there is at
 *    least one positive weight.
 *  - Weights that are non-finite or <= 0 are treated as 0. If NO key has a
 *    positive weight, the whole total is assigned to the last key so nothing
 *    is lost.
 */
export function allocateSellerAmounts(
  rawByKey: Record<string, number>,
  total: number
): Record<string, number> {
  const keys = Object.keys(rawByKey);
  const result: Record<string, number> = {};
  if (keys.length === 0) return result;

  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  if (safeTotal === 0) {
    for (const k of keys) result[k] = 0;
    return result;
  }

  const weights = keys.map((k) => {
    const w = rawByKey[k];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
  });
  const sumW = weights.reduce((a, b) => a + b, 0);

  if (sumW <= 0) {
    // No positive weights to proportion by — assign everything to the last
    // key deterministically rather than dropping the funds.
    for (const k of keys) result[k] = 0;
    result[keys[keys.length - 1]!] = safeTotal;
    return result;
  }

  const ideal = weights.map((w) => (w / sumW) * safeTotal);
  const alloc = ideal.map((v) => Math.floor(v));
  let remainder = safeTotal - alloc.reduce((a, b) => a + b, 0);

  // Hand the leftover units (always < number of keys) to the keys with the
  // largest fractional parts.
  const order = keys
    .map((_, i) => i)
    .sort((a, b) => ideal[b]! - alloc[b]! - (ideal[a]! - alloc[a]!));
  for (let i = 0; i < order.length && remainder > 0; i++) {
    alloc[order[i]!] = alloc[order[i]!]! + 1;
    remainder -= 1;
  }

  keys.forEach((k, i) => {
    result[k] = alloc[i]!;
  });
  return result;
}
