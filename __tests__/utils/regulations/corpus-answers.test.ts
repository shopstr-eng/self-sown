// Answer-level tests over the REAL wedge corpus data: not "does a channel
// exist" but "what does the engine actually answer". These pin the questions
// a completion review flagged — a no-channel question must never aggregate
// incompatible channels into a wrong verdict, and a resolved intrastate
// channel must carry the full requirement set.
//
// Pure: evaluateMatrix is a pure function; these tests feed it the corpus
// rows exactly as the store would (filtered by state + category).

import { WEDGE_CORPUS } from "@/utils/regulations/corpus";
import { evaluateMatrix } from "@/utils/regulations/engine";
import { parseQuestionSlots } from "@/utils/regulations/question-parser";
import type { CorpusRule } from "@/utils/regulations/schema";

function rulesFor(state: string, category: string): CorpusRule[] {
  return WEDGE_CORPUS.filter(
    (rule) => rule.state === state && rule.category === category
  );
}

function answer(question: string) {
  const slots = parseQuestionSlots(question);
  const rules =
    slots.state && slots.category ? rulesFor(slots.state, slots.category) : [];
  return evaluateMatrix(slots, rules);
}

describe("engine answers over the wedge corpus", () => {
  it("never aggregates incompatible channels: 'sell jam in Colorado' asks how", () => {
    // CO cottage food: direct channels are conditional, wholesale/retail/
    // interstate are prohibited. No channel resolved -> clarify, NOT a
    // prohibited verdict over a lawful farmers-market sale.
    const result = answer("Can I sell jam in Colorado?");
    expect(result.status).toBe("clarify");
    expect(result.missing).toContain("channel");
    expect(result.decision).toBeNull();
  });

  it("CO cottage food intrastate online carries the full requirement set", () => {
    const result = answer("Can I sell jam online within my state in Colorado?");
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("conditional");
    const slugs = result.rules.map((rule) => rule.id);
    for (const required of [
      "co-cottage_food-online_intrastate-allowed-products",
      "co-cottage_food-online_intrastate-food-safety-course",
      "co-cottage_food-online_intrastate-revenue-cap",
      "co-cottage_food-online_intrastate-labeling",
      "co-cottage_food-online_intrastate-direct-delivery-only",
    ]) {
      expect(slugs).toContain(required);
    }
  });

  it("WA raw milk at a farmers market: conditional with license and warning label", () => {
    const result = answer("Can I sell raw milk at a farmers market in Washington?");
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("conditional");
    const citations = result.rules.map((rule) => rule.citation_url);
    expect(citations.some((url) => url.includes("15.36.051"))).toBe(true);
    expect(citations.some((url) => url.includes("16-101-800"))).toBe(true);
  });

  it("CO raw milk at a farmers market: prohibited by the retail-sales ban", () => {
    const result = answer("Can I sell raw milk at a farmers market in Colorado?");
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("prohibited");
    expect(result.rules[0]?.citation_url).toContain("25-5-5-117");
  });

  it("interstate raw milk is prohibited in both wedge states via the federal rule", () => {
    for (const state of ["Washington", "Colorado"]) {
      const result = answer(`Can I ship raw milk to other states from ${state}?`);
      expect(result.status).toBe("answered");
      expect(result.decision).toBe("prohibited");
      expect(
        result.rules.some((rule) => rule.citation_url.includes("ecfr.gov"))
      ).toBe(true);
    }
  });

  it("CO herdshare: conditional with the registration and contract conditions", () => {
    const result = answer("Can I sell raw milk through a herd share in Colorado?");
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("conditional");
    expect(result.rules[0]?.conditions.join(" ")).toContain("CDPHE");
  });

  it("uncovered states fail closed to unknown", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = answer("Can I sell raw milk in Texas?");
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("no_corpus_for_state_category");
    warn.mockRestore();
  });
});
