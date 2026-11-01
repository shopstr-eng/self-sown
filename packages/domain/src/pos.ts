// Point-of-sale domain logic: pure cart math shared by the mobile PoS screens
// and the tests. No I/O, no React, no nostr-tools — the same rules as the web
// checkout's bulk selector (["bulk", bundleUnits, bundleTotalPrice] tags) are
// applied automatically here instead of via a dropdown.

export interface PosCatalogItem {
  /** Full Nostr address: 30402:<sellerPubkey>:<dTag>. */
  address: string;
  dTag: string;
  title: string;
  /** Base unit price in the listing currency's major units (fiat) or sats. */
  price: number;
  currency: string;
  /** Bundle pricing from "bulk" tags: bundle size -> TOTAL price per bundle. */
  bulkPrices?: Map<number, number>;
  /** First image URL, when the listing has one. */
  image?: string;
}

export interface PosCartLine {
  key: string;
  item: PosCatalogItem;
  quantity: number;
}

export interface PosLinePricing {
  quantity: number;
  /** Number of full discount bundles applied. */
  bundles: number;
  /** Bundle size applied (0 when no bulk tier applied). */
  bundleUnits: number;
  /** Units charged at base price. */
  remainderUnits: number;
  /** Line total in the line currency's major units / sats. */
  total: number;
  /** Amount saved vs. quantity * base price (0 when no discount). */
  savings: number;
}

export interface PosCartTotals {
  currency: string;
  subtotal: number;
  savings: number;
  total: number;
  lineCount: number;
  itemCount: number;
}

export const POS_MAX_LINE_QUANTITY = 10_000;
export const POS_MAX_NOTE_LENGTH = 512;
export const POS_EMAIL_MAX_LENGTH = 254;

const POS_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function roundMoney(value: number): number {
  // Cart math runs in major units; keep IEEE noise out of displayed/charged
  // totals. Sats lines carry integer values so the round is a no-op there.
  return Math.round(value * 100) / 100;
}

export function posCartLineKey(address: string): string {
  return address;
}

/**
 * Price a cart line, greedily applying the listing's bulk tiers: take as many
 * of the largest bundle as fit, then the next, and charge the remainder at
 * base price. Tier entries with non-positive or non-finite values are ignored
 * (a malformed "bulk" tag must never zero out a charge).
 */
export function pricePosCartLine(
  item: PosCatalogItem,
  quantity: number
): PosLinePricing {
  const qty = Math.max(1, Math.floor(quantity));
  const baseTotal = roundMoney(item.price * qty);
  const empty: PosLinePricing = {
    quantity: qty,
    bundles: 0,
    bundleUnits: 0,
    remainderUnits: qty,
    total: baseTotal,
    savings: 0,
  };
  if (!item.bulkPrices || item.bulkPrices.size === 0 || !isFinitePositive(item.price)) {
    return empty;
  }

  const tiers = Array.from(item.bulkPrices.entries())
    .filter(
      ([units, price]) =>
        Number.isInteger(units) &&
        units >= 2 &&
        isFinitePositive(price) &&
        // A "discount" at or above base price is not a discount.
        price < units * item.price
    )
    .sort((a, b) => b[0] - a[0]);

  let remaining = qty;
  let total = 0;
  let bundles = 0;
  let bundleUnits = 0;
  for (const [units, bundlePrice] of tiers) {
    if (remaining < units) continue;
    const count = Math.floor(remaining / units);
    total += count * bundlePrice;
    remaining -= count * units;
    bundles += count;
    if (bundleUnits === 0) bundleUnits = units;
  }
  total += remaining * item.price;
  total = roundMoney(total);

  return {
    quantity: qty,
    bundles,
    bundleUnits,
    remainderUnits: remaining,
    total,
    savings: roundMoney(baseTotal - total),
  };
}

/**
 * Cart totals. Throws when lines mix currencies — a PoS charge is a single
 * payment in a single currency, so the picker rejects cross-currency adds
 * before this point; the throw is the fail-closed backstop.
 */
export function computePosCartTotals(lines: PosCartLine[]): PosCartTotals {
  const currency = lines[0]?.item.currency ?? "";
  let subtotal = 0;
  let savings = 0;
  let itemCount = 0;
  for (const line of lines) {
    if (line.item.currency !== currency) {
      throw new Error(
        `Cannot mix ${currency} and ${line.item.currency} in one sale.`
      );
    }
    const pricing = pricePosCartLine(line.item, line.quantity);
    subtotal += roundMoney(line.item.price * pricing.quantity);
    savings += pricing.savings;
    itemCount += pricing.quantity;
  }
  return {
    currency,
    subtotal: roundMoney(subtotal),
    savings: roundMoney(savings),
    total: roundMoney(subtotal - savings),
    lineCount: lines.length,
    itemCount,
  };
}

export function validatePosNote(note: string): string | null {
  if (note.length > POS_MAX_NOTE_LENGTH) {
    return `Note must be ${POS_MAX_NOTE_LENGTH} characters or fewer.`;
  }
  return null;
}

export function validatePosBuyerEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return null; // optional
  if (trimmed.length > POS_EMAIL_MAX_LENGTH || !POS_EMAIL_RE.test(trimmed)) {
    return "Enter a valid email address for the receipt.";
  }
  return null;
}

export type PosPaymentMethod = "lightning" | "card" | "cash";

export interface PosSaleRecordInput {
  orderId: string;
  sellerPubkey: string;
  line: PosCartLine;
  pricing: PosLinePricing;
  paymentMethod: PosPaymentMethod;
  paymentReference: string;
  note?: string;
  buyerEmail?: string;
}

/**
 * Build the kind:14 rumor tags + content for one PoS sale line, mirroring the
 * online order format (sendGiftWrappedMessage isOrder branch) so the seller's
 * Orders tabs on web and mobile parse PoS sales with zero changes:
 *   ["item", address, qty], ["amount", total], ["currency", cur],
 *   ["payment", method, reference], ["buyer_type", "guest"], ...
 * The seller authors and self-addresses the rumor (buyerPubkey = seller
 * pubkey) — parseSellerOrderMessage derives buyerPubkey from event.pubkey.
 */
export function buildPosOrderRumorParts(input: PosSaleRecordInput): {
  tags: string[][];
  content: string;
} {
  const tags: string[][] = [
    ["p", input.sellerPubkey],
    ["subject", "order-payment"],
    ["order", input.orderId],
    [
      "item",
      input.line.item.address,
      String(Math.max(1, Math.floor(input.line.quantity))),
    ],
    ["buyer_type", "guest"],
    ["amount", String(input.pricing.total)],
    ["currency", input.line.item.currency],
    ["payment", input.paymentMethod, input.paymentReference],
    ["status", "completed"],
  ];
  if (input.buyerEmail) tags.push(["buyer_email", input.buyerEmail]);
  if (input.pricing.bundles > 0) {
    tags.push(["bulk", String(input.pricing.bundleUnits)]);
  }

  const lines = [
    `Product: ${input.line.item.title}`,
    `Quantity: ${Math.max(1, Math.floor(input.line.quantity))}`,
    `Total: ${input.pricing.total} ${input.line.item.currency}`,
  ];
  if (input.note) lines.push(`Note: ${input.note}`);
  return { tags, content: lines.join("\n") };
}
