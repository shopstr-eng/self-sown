/** @jest-environment node */

/**
 * LIVE explanation-drift eval: runs every answered golden regulation case
 * through explainEngineResult against the REAL configured Anthropic model and
 * reports template-fallback rate, validation-failure reasons, and
 * decision-contradiction count (utils/regulations/live-explain-eval.ts).
 *
 * GATED: runs ONLY when RUN_LIVE_EVAL=1. It spends tokens and depends on
 * model availability, so it must never join the default Jest run or CI —
 * run it on corpus/model/prompt changes per docs/regulations-attorney-review.md:
 *
 *   RUN_LIVE_EVAL=1 npx jest __tests__/utils/regulations/live-explain-eval.test.ts --runInBand
 *
 * Hard failures (what a scheduled run should alert on):
 *   - any decision contradiction: the model argued against the engine. The
 *     fail-closed validator caught it, but the model has drifted.
 *   - a 100% template-fallback rate: the model path is contributing nothing
 *     at all — silent drift that CI's deterministic harness cannot see.
 * Individual validation failures are reported, not failed: a rejected body
 * still served the safe template, which is the system working as designed.
 */

import {
  formatLiveEvalReport,
  runLiveExplainEval,
} from "@/utils/regulations/live-explain-eval";
import { GOLDEN_CASES } from "@/utils/regulations/golden-answers";

const RUN = process.env.RUN_LIVE_EVAL === "1";
const describeLive = RUN ? describe : describe.skip;

describeLive("golden cases against the real model (LIVE eval)", () => {
  jest.setTimeout(600_000);

  it("reports fallback rate and reasons, with zero decision contradictions", async () => {
    const report = await runLiveExplainEval();
    console.log(formatLiveEvalReport(report));

    // Sanity: the eval actually exercised the seam. Every golden case that
    // expects an answer must have reached the model — a partial run (parser
    // or engine drift) must not look healthy.
    const expectedAnswered = GOLDEN_CASES.filter(
      (goldenCase) => goldenCase.expect.status === "answered"
    ).length;
    expect(report.answeredCases).toBe(expectedAnswered);
    expect(report.evaluatedCases).toBe(expectedAnswered);

    // no_client means the credentials weren't visible to the test process —
    // that's a broken eval run, not a passing one. Needs
    // AI_INTEGRATIONS_ANTHROPIC_API_KEY/BASE_URL or ANTHROPIC_API_KEY.
    const noClient = report.cases.filter((c) => c.outcome === "no_client");
    expect(noClient.map((c) => c.id)).toEqual([]);

    // A contradiction means the real model argued against an engine decision
    // (bodies still fell back safely, but the model has drifted).
    expect(report.decisionContradictionCount).toBe(0);

    // A 100% fallback rate means the model path is contributing nothing.
    expect(report.templateFallbackCount).toBeLessThan(report.evaluatedCases);
  });
});
