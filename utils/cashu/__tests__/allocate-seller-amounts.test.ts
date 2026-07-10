import { allocateSellerAmounts } from "../allocate-seller-amounts";

const sum = (r: Record<string, number>) =>
  Object.values(r).reduce((a, b) => a + b, 0);

describe("allocateSellerAmounts", () => {
  it("gives a single key the entire total (discount case)", () => {
    // Seller subtotal 1000, but only the discounted 800 was minted.
    expect(allocateSellerAmounts({ a: 1000 }, 800)).toEqual({ a: 800 });
  });

  it("returns 0 for every key when total is 0", () => {
    expect(allocateSellerAmounts({ a: 100, b: 50 }, 0)).toEqual({ a: 0, b: 0 });
  });

  it("splits evenly for equal weights and even total", () => {
    expect(allocateSellerAmounts({ a: 1, b: 1 }, 100)).toEqual({
      a: 50,
      b: 50,
    });
  });

  it("splits proportionally and sums exactly to total", () => {
    const r = allocateSellerAmounts({ a: 600, b: 400 }, 900);
    expect(r).toEqual({ a: 540, b: 360 });
    expect(sum(r)).toBe(900);
  });

  it("distributes indivisible remainder without drift", () => {
    const r = allocateSellerAmounts({ a: 1, b: 1, c: 1 }, 10);
    expect(sum(r)).toBe(10);
    // floors are 3/3/3, one key must absorb the +1
    const vals = Object.values(r).sort();
    expect(vals).toEqual([3, 3, 4]);
  });

  it("preserves proportions under a discount ratio and sums to total", () => {
    // raw items+shipping per seller, minted total is 20% off => 880
    const r = allocateSellerAmounts({ a: 700, b: 300, c: 100 }, 880);
    expect(sum(r)).toBe(880);
    // largest weight keeps the largest share
    expect(r.a).toBeGreaterThan(r.b!);
    expect(r.b).toBeGreaterThan(r.c!);
  });

  it("treats non-positive / non-finite weights as zero", () => {
    const r = allocateSellerAmounts(
      { a: 1000, b: 0, c: -5, d: NaN as unknown as number },
      500
    );
    expect(r.a).toBe(500);
    expect(r.b).toBe(0);
    expect(r.c).toBe(0);
    expect(r.d).toBe(0);
    expect(sum(r)).toBe(500);
  });

  it("assigns the whole total to the last key when no weight is positive", () => {
    const r = allocateSellerAmounts({ a: 0, b: 0 }, 300);
    expect(r).toEqual({ a: 0, b: 300 });
  });

  it("returns an empty object for no keys", () => {
    expect(allocateSellerAmounts({}, 500)).toEqual({});
  });

  it("floors a fractional total", () => {
    const r = allocateSellerAmounts({ a: 1, b: 1 }, 101.9);
    expect(sum(r)).toBe(101);
  });

  it("always sums exactly to the total across random inputs", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 500; iter++) {
      const n = 1 + Math.floor(rand() * 6);
      const raw: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        raw[`k${i}`] = Math.floor(rand() * 5000);
      }
      const total = Math.floor(rand() * 20000);
      const r = allocateSellerAmounts(raw, total);
      const hasPositive = Object.values(raw).some((w) => w > 0);
      if (hasPositive || total === 0) {
        expect(sum(r)).toBe(total);
      } else {
        // no positive weights: still conserves the total
        expect(sum(r)).toBe(total);
      }
      for (const v of Object.values(r)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});
