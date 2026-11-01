/** @jest-environment node */

// Receipt text for Apple Tap to Pay 5.10: itemized, shareable via the system
// sheet, and correct for declined card attempts as well as approved sales.

import type { PosCartLine } from "@self-sown/domain";

import type { PosCompletedSale } from "../../apps/mobile/lib/pos-cart-store";
import {
  buildPosReceiptLines,
  formatDeclinedCardReceiptText,
  formatPosReceiptText,
} from "../../apps/mobile/lib/pos-receipt";

function catalogItem(overrides: {
  title: string;
  price: number;
  currency?: string;
  bulkPrices?: Map<number, number>;
}) {
  return {
    address: `30402:pubkey:${overrides.title}`,
    dTag: overrides.title,
    title: overrides.title,
    price: overrides.price,
    currency: overrides.currency ?? "USD",
    ...(overrides.bulkPrices ? { bulkPrices: overrides.bulkPrices } : {}),
  };
}

function cartLine(
  title: string,
  price: number,
  quantity: number,
  bulkPrices?: Map<number, number>
): PosCartLine {
  const item = catalogItem({
    title,
    price,
    ...(bulkPrices ? { bulkPrices } : {}),
  });
  return { key: item.address, item, quantity };
}

describe("buildPosReceiptLines", () => {
  it("prices each line including bulk-tier discounts", () => {
    const lines = buildPosReceiptLines([
      cartLine("Honey jar", 8, 2),
      cartLine("Milk", 5, 6, new Map([[6, 25]])),
    ]);
    expect(lines).toEqual([
      { title: "Honey jar", quantity: 2, total: 16 },
      { title: "Milk", quantity: 6, total: 25 },
    ]);
  });
});

describe("formatPosReceiptText", () => {
  const sale: PosCompletedSale = {
    saleId: "sale-1",
    method: "card",
    reference: "pi_test",
    total: 41,
    currency: "USD",
    itemCount: 8,
    receiptLines: [
      { title: "Honey jar", quantity: 2, total: 16 },
      { title: "Milk", quantity: 6, total: 25 },
    ],
  };

  it("itemizes lines, total, and payment method", () => {
    const text = formatPosReceiptText(sale);
    expect(text).toContain("Honey jar × 2 — $16.00");
    expect(text).toContain("Milk × 6 — $25.00");
    expect(text).toContain("Total: $41.00");
    expect(text).toContain("Paid by: Card");
  });

  it("falls back to the item count when no lines were captured", () => {
    const text = formatPosReceiptText({ ...sale, receiptLines: [] });
    expect(text).toContain("8 items");
    expect(text).toContain("Total: $41.00");
  });
});

describe("formatDeclinedCardReceiptText", () => {
  it("states the attempted amount and that no charge was made", () => {
    const text = formatDeclinedCardReceiptText({ total: 41, currency: "USD" });
    expect(text).toContain("$41.00");
    expect(text).toContain("not approved");
    expect(text).toContain("no charge was made");
  });
});
