import {
  proofAmountToNumber,
  sumProofAmounts,
} from "@/utils/cashu/proof-amount";

// Proof amounts arrive as number (hand-built), numeric string (stored
// kind-7375 JSON — cashu-ts v4 Amount instances serialize as strings), or
// Amount instances (v4 decodes + wallet outputs). Naive `sum + (p.amount
// || 0)` concatenated them ("0" + "100" = "0100") and `.toNumber()` throws
// on strings — both corrupt totals silently.

describe("proofAmountToNumber", () => {
  it("passes numbers through", () => {
    expect(proofAmountToNumber({ amount: 100 } as any)).toBe(100);
  });

  it("parses numeric strings (stored JSON / serialized Amount)", () => {
    expect(proofAmountToNumber({ amount: "100" } as any)).toBe(100);
  });

  it("unwraps cashu-ts Amount instances", () => {
    expect(proofAmountToNumber({ amount: { toNumber: () => 21 } } as any)).toBe(
      21
    );
  });

  it("returns 0 for unusable values", () => {
    expect(proofAmountToNumber({ amount: undefined } as any)).toBe(0);
    expect(proofAmountToNumber({ amount: null } as any)).toBe(0);
    expect(proofAmountToNumber({ amount: "junk" } as any)).toBe(0);
  });
});

describe("sumProofAmounts", () => {
  it("sums mixed shapes without string concatenation", () => {
    expect(
      sumProofAmounts([
        { amount: 100 },
        { amount: "50" },
        { amount: { toNumber: () => 7 } },
      ] as any)
    ).toBe(157);
  });

  it("returns 0 for empty or non-array input", () => {
    expect(sumProofAmounts([])).toBe(0);
    expect(sumProofAmounts(undefined as any)).toBe(0);
  });
});
