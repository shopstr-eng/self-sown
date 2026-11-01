import {
  buildPosOrderRumorParts,
  computePosCartTotals,
  POS_MAX_NOTE_LENGTH,
  pricePosCartLine,
  validatePosBuyerEmail,
  validatePosNote,
  type PosCartLine,
  type PosCatalogItem,
} from "../pos";

const SELLER = "a".repeat(64);

function makeItem(overrides: Partial<PosCatalogItem> = {}): PosCatalogItem {
  return {
    address: `30402:${SELLER}:milk`,
    dTag: "milk",
    title: "Raw milk",
    price: 5,
    currency: "USD",
    ...overrides,
  };
}

function makeLine(
  item: PosCatalogItem,
  quantity: number
): PosCartLine {
  return { key: item.address, item, quantity };
}

describe("pricePosCartLine", () => {
  it("charges base price when the listing has no bulk tiers", () => {
    const pricing = pricePosCartLine(makeItem(), 3);
    expect(pricing.total).toBe(15);
    expect(pricing.bundles).toBe(0);
    expect(pricing.savings).toBe(0);
    expect(pricing.remainderUnits).toBe(3);
  });

  it("applies the largest fitting bundle and charges the remainder at base", () => {
    const item = makeItem({
      bulkPrices: new Map([
        [6, 25], // 6 for $25 (base $30)
        [12, 45], // 12 for $45 (base $60)
      ]),
    });
    const pricing = pricePosCartLine(item, 14);
    expect(pricing.bundles).toBe(1);
    expect(pricing.bundleUnits).toBe(12);
    expect(pricing.remainderUnits).toBe(2);
    expect(pricing.total).toBe(55); // 45 + 2*5
    expect(pricing.savings).toBe(15); // 70 - 55
  });

  it("stacks multiple bundles of the same tier", () => {
    const item = makeItem({ bulkPrices: new Map([[3, 12]]) });
    const pricing = pricePosCartLine(item, 7);
    expect(pricing.bundles).toBe(2);
    expect(pricing.remainderUnits).toBe(1);
    expect(pricing.total).toBe(29); // 2*12 + 5
  });

  it("ignores tiers that are not actually cheaper than base price", () => {
    const item = makeItem({ bulkPrices: new Map([[4, 20]]) }); // 4*5 = 20
    const pricing = pricePosCartLine(item, 4);
    expect(pricing.bundles).toBe(0);
    expect(pricing.total).toBe(20);
    expect(pricing.savings).toBe(0);
  });

  it("ignores malformed tiers (zero/negative/non-integer)", () => {
    const item = makeItem({
      bulkPrices: new Map([
        [0, 1],
        [-3, 1],
        [2.5, 8],
        [4, 0],
      ]),
    });
    const pricing = pricePosCartLine(item, 10);
    expect(pricing.total).toBe(50);
    expect(pricing.bundles).toBe(0);
  });

  it("floors fractional quantities and never charges below one unit", () => {
    const pricing = pricePosCartLine(makeItem(), 2.9);
    expect(pricing.quantity).toBe(2);
    expect(pricing.total).toBe(10);
  });

  it("handles free listings without invoking tiers", () => {
    const item = makeItem({ price: 0, bulkPrices: new Map([[5, 0]]) });
    const pricing = pricePosCartLine(item, 5);
    expect(pricing.total).toBe(0);
    expect(pricing.bundles).toBe(0);
  });
});

describe("computePosCartTotals", () => {
  it("sums lines and savings", () => {
    const discounted = makeItem({
      address: `30402:${SELLER}:cheese`,
      dTag: "cheese",
      title: "Cheese",
      price: 10,
      bulkPrices: new Map([[2, 18]]),
    });
    const totals = computePosCartTotals([
      makeLine(makeItem(), 2), // 10
      makeLine(discounted, 2), // 18 (saves 2)
    ]);
    expect(totals).toEqual({
      currency: "USD",
      subtotal: 30,
      savings: 2,
      total: 28,
      lineCount: 2,
      itemCount: 4,
    });
  });

  it("rejects mixed currencies", () => {
    const satsItem = makeItem({
      address: `30402:${SELLER}:sats-item`,
      currency: "SATS",
    });
    expect(() =>
      computePosCartTotals([makeLine(makeItem(), 1), makeLine(satsItem, 1)])
    ).toThrow(/mix/i);
  });

  it("returns an empty cart shape for no lines", () => {
    expect(computePosCartTotals([])).toEqual({
      currency: "",
      subtotal: 0,
      savings: 0,
      total: 0,
      lineCount: 0,
      itemCount: 0,
    });
  });
});

describe("validators", () => {
  it("bounds the note length", () => {
    expect(validatePosNote("all good")).toBeNull();
    expect(validatePosNote("x".repeat(POS_MAX_NOTE_LENGTH + 1))).toMatch(
      /characters or fewer/
    );
  });

  it("accepts an empty email and rejects malformed ones", () => {
    expect(validatePosBuyerEmail("")).toBeNull();
    expect(validatePosBuyerEmail("  ")).toBeNull();
    expect(validatePosBuyerEmail("buyer@example.com")).toBeNull();
    expect(validatePosBuyerEmail("nope")).toMatch(/valid email/);
  });
});

describe("buildPosOrderRumorParts", () => {
  it("mirrors the online order tag contract", () => {
    const item = makeItem({ bulkPrices: new Map([[6, 25]]) });
    const pricing = pricePosCartLine(item, 7);
    const { tags, content } = buildPosOrderRumorParts({
      orderId: "sale-1",
      sellerPubkey: SELLER,
      line: makeLine(item, 7),
      pricing,
      paymentMethod: "lightning",
      paymentReference: "lnbc1example",
      note: "farmers market",
      buyerEmail: "buyer@example.com",
    });

    expect(tags).toContainEqual(["p", SELLER]);
    expect(tags).toContainEqual(["subject", "order-payment"]);
    expect(tags).toContainEqual(["order", "sale-1"]);
    expect(tags).toContainEqual(["item", item.address, "7"]);
    expect(tags).toContainEqual(["buyer_type", "guest"]);
    expect(tags).toContainEqual(["amount", "30"]);
    expect(tags).toContainEqual(["currency", "USD"]);
    expect(tags).toContainEqual(["payment", "lightning", "lnbc1example"]);
    expect(tags).toContainEqual(["status", "completed"]);
    expect(tags).toContainEqual(["buyer_email", "buyer@example.com"]);
    expect(tags).toContainEqual(["bulk", "6"]);
    expect(content).toContain("Product: Raw milk");
    expect(content).toContain("Note: farmers market");
  });

  it("omits optional tags when not provided", () => {
    const item = makeItem();
    const pricing = pricePosCartLine(item, 1);
    const { tags, content } = buildPosOrderRumorParts({
      orderId: "sale-2",
      sellerPubkey: SELLER,
      line: makeLine(item, 1),
      pricing,
      paymentMethod: "cash",
      paymentReference: "cash",
    });
    expect(tags.some((t) => t[0] === "buyer_email")).toBe(false);
    expect(tags.some((t) => t[0] === "bulk")).toBe(false);
    expect(content).not.toContain("Note:");
  });
});
