// The golden Q&A eval — the CI gate from the P0 trust layer
// (docs/producer-platform-plan.md). A corpus, parser, engine, or explainer
// change that breaks one of these attorney-reviewable answers fails this
// suite, and this suite runs in CI (pnpm run test:coverage on every PR).
//
// The second describe block is the deliberate-break proof the task requires:
// it feeds the harness tampered corpora and asserts the harness reports the
// break, so "CI fails when a corpus/model change breaks a golden answer" is
// itself tested, not assumed.

import {
  GOLDEN_CASES,
  runGoldenCase,
} from "@/utils/regulations/golden-answers";
import { WEDGE_CORPUS } from "@/utils/regulations/corpus";
import type { CorpusRule } from "@/utils/regulations/schema";

describe("golden Q&A eval over the wedge corpus", () => {
  it.each(GOLDEN_CASES.map((goldenCase) => [goldenCase.id, goldenCase] as const))(
    "%s",
    async (_id, goldenCase) => {
      const outcome = await runGoldenCase(goldenCase);
      expect(outcome.failures).toEqual([]);
      expect(outcome.pass).toBe(true);
    }
  );

  it("covers every wedge state × category cell", () => {
    const cells = new Set(
      GOLDEN_CASES.filter((goldenCase) => goldenCase.expect.status === "answered").map(
        (goldenCase) => goldenCase.id.split("-").slice(0, 2).join("-")
      )
    );
    for (const cell of [
      "wa-cottage",
      "wa-raw",
      "wa-eggs",
      "co-cottage",
      "co-raw",
      "co-eggs",
    ]) {
      expect(cells.has(cell)).toBe(true);
    }
  });

  it("every case carries review provenance, and sign-off cannot be faked", () => {
    for (const goldenCase of GOLDEN_CASES) {
      expect(goldenCase.sourceMatrix.length).toBeGreaterThan(0);
      expect(goldenCase.review).toBeDefined();
      if (goldenCase.review.status === "approved") {
        // An approved case must name a real reviewer and date — nobody may
        // flip the status field alone to claim attorney sign-off.
        expect(goldenCase.review.reviewer).toBeTruthy();
        expect(goldenCase.review.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});

describe("deliberate-break proofs: the harness catches drift", () => {
  function tamper(
    predicate: (rule: CorpusRule) => boolean,
    mutate: (rule: CorpusRule) => CorpusRule
  ): CorpusRule[] {
    return WEDGE_CORPUS.map((rule) => (predicate(rule) ? mutate(rule) : rule));
  }

  it("a flipped decision in the corpus fails the matching golden case", async () => {
    // Simulate a corpus edit that wrongly allows interstate cottage food
    // sales from WA.
    const broken = tamper(
      (rule) =>
        rule.state === "WA" &&
        rule.category === "cottage_food" &&
        rule.channel === "online_interstate",
      (rule) => ({ ...rule, decision: "allowed" })
    );
    const goldenCase = GOLDEN_CASES.find(
      (entry) => entry.id === "wa-cottage-food-interstate"
    );
    expect(goldenCase).toBeDefined();
    const outcome = await runGoldenCase(goldenCase!, broken);
    expect(outcome.pass).toBe(false);
    expect(outcome.failures.some((failure) => failure.includes("decision"))).toBe(
      true
    );
  });

  it("a broken citation URL fails the matching golden case", async () => {
    const broken = tamper(
      (rule) => rule.citation_url.includes("15.36.051"),
      (rule) => ({
        ...rule,
        citation_url: rule.citation_url.replace("15.36.051", "99.99.999"),
      })
    );
    const goldenCase = GOLDEN_CASES.find(
      (entry) => entry.id === "wa-raw-milk-farmers-market"
    );
    const outcome = await runGoldenCase(goldenCase!, broken);
    expect(outcome.pass).toBe(false);
    expect(
      outcome.failures.some((failure) => failure.includes("15.36.051"))
    ).toBe(true);
  });

  it("a dropped requirement condition fails the matching golden case", async () => {
    // Simulate losing the WA cottage-food revenue cap condition.
    const broken = tamper(
      (rule) => rule.citation_url.includes("69.22.050"),
      (rule) => ({
        ...rule,
        conditions: rule.conditions.map((condition) =>
          condition.replace("$35,000", "$0")
        ),
        statute_excerpt: rule.statute_excerpt.replaceAll("$35,000", "$0"),
      })
    );
    const goldenCase = GOLDEN_CASES.find(
      (entry) => entry.id === "wa-cottage-food-farmers-market"
    );
    const outcome = await runGoldenCase(goldenCase!, broken);
    expect(outcome.pass).toBe(false);
    expect(
      outcome.failures.some((failure) => failure.includes("$35,000"))
    ).toBe(true);
  });

  it("advisory phrasing in rendered output fails the eval", async () => {
    const broken = tamper(
      (rule) => rule.citation_url.includes("69.25.050"),
      (rule) => ({
        ...rule,
        conditions: [...rule.conditions, "You should apply early."],
      })
    );
    const goldenCase = GOLDEN_CASES.find(
      (entry) => entry.id === "wa-eggs-farmers-market"
    );
    const outcome = await runGoldenCase(goldenCase!, broken);
    expect(outcome.pass).toBe(false);
    expect(
      outcome.failures.some((failure) => failure.includes("advisory phrasing"))
    ).toBe(true);
  });
});
