/** @jest-environment node */

// The "newer wins" stock rule is shared by SSR, the UCP catalog and the browser
// cards, so these tests pin its edge cases: equal timestamps, missing
// timestamps, partial rows and untracked products.

import {
  LOW_STOCK_THRESHOLD,
  applyStockToProduct,
  getStockState,
  newerStockOnly,
  type InventorySnapshot,
} from "@/utils/inventory/live-stock";

const LISTED_AT = 1_700_000_000;

function snapshot(overrides: Partial<InventorySnapshot> = {}) {
  return {
    default_quantity: null,
    variants: {},
    ...overrides,
  } as InventorySnapshot;
}

describe("newerStockOnly", () => {
  it("returns null without a snapshot", () => {
    expect(newerStockOnly(null, LISTED_AT)).toBeNull();
    expect(newerStockOnly(undefined, LISTED_AT)).toBeNull();
  });

  it("keeps a row written after the listing", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 3, default_updated_at: LISTED_AT + 1 }),
      LISTED_AT
    );
    expect(result).toEqual({ default_quantity: 3, variants: {} });
  });

  it("drops a row written before the listing", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 3, default_updated_at: LISTED_AT - 1 }),
      LISTED_AT
    );
    expect(result).toBeNull();
  });

  it("does not treat a row written at the same second as newer", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 3, default_updated_at: LISTED_AT }),
      LISTED_AT
    );
    expect(result).toBeNull();
  });

  it("reads a listing time that arrives as a string, as Postgres returns bigint", () => {
    const old = snapshot({
      default_quantity: 0,
      default_updated_at: LISTED_AT - 1,
    });
    const fresh = snapshot({
      default_quantity: 0,
      default_updated_at: LISTED_AT + 1,
    });
    const listedAt = String(LISTED_AT) as unknown as number;
    expect(newerStockOnly(old, listedAt)).toBeNull();
    expect(newerStockOnly(fresh, listedAt)?.default_quantity).toBe(0);
  });

  it("reads a row time that arrives as a string", () => {
    const stale = snapshot({
      default_quantity: 0,
      default_updated_at: String(LISTED_AT - 1) as unknown as number,
    });
    expect(newerStockOnly(stale, LISTED_AT)).toBeNull();
  });

  it("treats a blank or non-numeric listing time as unknown", () => {
    const old = snapshot({
      default_quantity: 1,
      default_updated_at: LISTED_AT - 1,
    });
    for (const bad of ["", "abc", 0, null, Number.NaN]) {
      expect(
        newerStockOnly(old, bad as unknown as number)?.default_quantity
      ).toBe(1);
    }
  });

  it("trusts rows that have no timestamp", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 0, variants: { "size:S": 2 } }),
      LISTED_AT
    );
    expect(result).toEqual({ default_quantity: 0, variants: { "size:S": 2 } });
  });

  it("trusts rows when the listing time is unknown", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 1, default_updated_at: 5 }),
      undefined
    );
    expect(result?.default_quantity).toBe(1);
  });

  it("judges each variant row on its own timestamp", () => {
    const result = newerStockOnly(
      snapshot({
        variants: { "size:S": 1, "size:M": 4 },
        variant_updated_at: {
          "size:S": LISTED_AT + 10,
          "size:M": LISTED_AT - 10,
        },
      }),
      LISTED_AT
    );
    expect(result).toEqual({
      default_quantity: null,
      variants: { "size:S": 1 },
    });
  });

  it("keeps a zero quantity, because zero is a real count", () => {
    const result = newerStockOnly(
      snapshot({ default_quantity: 0, default_updated_at: LISTED_AT + 1 }),
      LISTED_AT
    );
    expect(result?.default_quantity).toBe(0);
  });
});

describe("applyStockToProduct", () => {
  const product = {
    createdAt: LISTED_AT,
    quantity: 10,
    sizes: ["S", "M"],
    sizeQuantities: new Map([
      ["S", 5],
      ["M", 5],
    ]),
  };

  it("returns the same object when there is no newer stock", () => {
    expect(applyStockToProduct(product, null)).toBe(product);
    expect(
      applyStockToProduct(
        product,
        snapshot({ default_quantity: 2, default_updated_at: LISTED_AT - 5 })
      )
    ).toBe(product);
  });

  it("returns the same object when newer stock matches the listing", () => {
    const result = applyStockToProduct(
      product,
      snapshot({ default_quantity: 10, default_updated_at: LISTED_AT + 1 })
    );
    expect(result).toBe(product);
  });

  it("overrides the default quantity with newer stock", () => {
    const result = applyStockToProduct(
      product,
      snapshot({ default_quantity: 2, default_updated_at: LISTED_AT + 1 })
    );
    expect(result.quantity).toBe(2);
    expect(result.sizeQuantities).toEqual(product.sizeQuantities);
  });

  it("overrides only the sizes that have newer rows, without mutating the input", () => {
    const result = applyStockToProduct(
      product,
      snapshot({
        variants: { "size:S": 0, "size:L": 9 },
        variant_updated_at: {
          "size:S": LISTED_AT + 1,
          "size:L": LISTED_AT + 1,
        },
      })
    );
    expect(result.sizeQuantities?.get("S")).toBe(0);
    expect(result.sizeQuantities?.get("M")).toBe(5);
    expect(result.sizeQuantities?.has("L")).toBe(false);
    expect(product.sizeQuantities.get("S")).toBe(5);
  });

  it("works for products with no listing quantity", () => {
    const untracked: { createdAt: number; quantity?: number } = {
      createdAt: LISTED_AT,
    };
    const result = applyStockToProduct(
      untracked,
      snapshot({ default_quantity: 0, default_updated_at: LISTED_AT + 1 })
    );
    expect(result.quantity).toBe(0);
  });
});

describe("getStockState", () => {
  it("never calls an untracked product sold out", () => {
    expect(getStockState({})).toEqual({ soldOut: false, lowStock: null });
  });

  it("is sold out at zero", () => {
    expect(getStockState({ quantity: 0 }).soldOut).toBe(true);
  });

  it("ignores a quantity that is not a number", () => {
    expect(getStockState({ quantity: Number.NaN })).toEqual({
      soldOut: false,
      lowStock: null,
    });
  });

  it("reports low stock up to the threshold only", () => {
    expect(getStockState({ quantity: LOW_STOCK_THRESHOLD }).lowStock).toBe(
      LOW_STOCK_THRESHOLD
    );
    expect(
      getStockState({ quantity: LOW_STOCK_THRESHOLD + 1 }).lowStock
    ).toBeNull();
  });

  it("is sold out only when every size is empty", () => {
    const sizes = ["S", "M"];
    expect(
      getStockState({
        sizes,
        sizeQuantities: new Map([
          ["S", 0],
          ["M", 0],
        ]),
      }).soldOut
    ).toBe(true);
    expect(
      getStockState({
        sizes,
        sizeQuantities: new Map([
          ["S", 0],
          ["M", 2],
        ]),
      })
    ).toEqual({ soldOut: false, lowStock: 2 });
  });

  it("does not guess when a size has no quantity", () => {
    expect(
      getStockState({
        sizes: ["S", "M"],
        sizeQuantities: new Map([["S", 0]]),
      }).soldOut
    ).toBe(false);
  });

  it("uses the scarcest limit when both a default and sizes exist", () => {
    expect(
      getStockState({
        quantity: 2,
        sizes: ["S"],
        sizeQuantities: new Map([["S", 50]]),
      }).lowStock
    ).toBe(2);
  });
});
