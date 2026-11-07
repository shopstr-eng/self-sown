// Live explanation-drift eval — the scheduled complement to the CI golden
// harness (./golden-answers). CI intentionally never calls the model, so it
// proves only the deterministic floor. This runner sends every answered
// golden case through explainEngineResult against the REAL configured model
// and reports what CI cannot see:
//
//   - template-fallback rate: how often the model's body was rejected (or
//     the call failed) and users silently got the deterministic template.
//     A creeping rate means the model or prompt drifted even though every
//     served answer stayed safe.
//   - validation-failure reasons: WHY bodies were rejected (invented
//     citation URLs, advisory phrasing, missing citations, over-length).
//   - decision-contradiction count: bodies that argued against the engine's
//     decision — the most dangerous drift class, and the one this eval must
//     keep at zero.
//
// Cadence: run on every corpus change, ASSISTANT_MODEL bump, or explain
// prompt change — see docs/regulations-attorney-review.md. Gated behind
// RUN_LIVE_EVAL=1 (__tests__/utils/regulations/live-explain-eval.test.ts);
// it spends tokens and must never run in the default Jest suite or CI.
//
// Clarify/unknown golden cases are reported as not evaluated: by contract
// the model is never invoked for them, so there is nothing to drift-check.

import { WEDGE_CORPUS } from "./corpus";
import { evaluateMatrix } from "./engine";
import { parseQuestionSlots } from "./question-parser";
import {
  explainEngineResult,
  renderDeterministicExplanation,
  type ExplainOutcome,
} from "./explain";
import { GOLDEN_CASES } from "./golden-set";
import type { CorpusRule, EngineResult } from "./schema";

export interface LiveCaseReport {
  id: string;
  question: string;
  // What the engine decided for the question (drives the eval; clarify and
  // unknown cases are never sent to the model).
  status: EngineResult["status"];
  decision: EngineResult["decision"];
  evaluated: boolean;
  outcome: ExplainOutcome["kind"] | null;
  // True when the served text is byte-identical to the deterministic
  // template — i.e. the model contributed nothing to this answer.
  templateFallback: boolean | null;
  validationReasons: string[];
  // Bodies that contradicted the engine's decision (subset of the reasons).
  contradictionCount: number;
}

export interface LiveEvalReport {
  totalCases: number;
  answeredCases: number;
  evaluatedCases: number;
  templateFallbackCount: number;
  // Fraction of evaluated cases that fell back to the template (0 when none
  // were evaluated). The headline drift signal.
  templateFallbackRate: number;
  decisionContradictionCount: number;
  validationFailureReasons: string[];
  cases: LiveCaseReport[];
}

function engineResultFor(question: string, rules: CorpusRule[]): EngineResult {
  const slots = parseQuestionSlots(question);
  const scoped =
    slots.state && slots.category
      ? rules.filter(
          (rule) =>
            rule.state === slots.state && rule.category === slots.category
        )
      : [];
  return evaluateMatrix(slots, scoped);
}

/**
 * Run every golden case through the live explain seam. Cases run serially —
 * the corpus is small and a burst of parallel model calls would only make a
 * scheduled run flakier. Throws nothing on model errors: they are reported
 * per-case as model_error outcomes, which is itself a drift signal.
 */
export async function runLiveExplainEval(
  rules: CorpusRule[] = WEDGE_CORPUS
): Promise<LiveEvalReport> {
  const cases: LiveCaseReport[] = [];

  for (const goldenCase of GOLDEN_CASES) {
    const result = engineResultFor(goldenCase.question, rules);
    const base: LiveCaseReport = {
      id: goldenCase.id,
      question: goldenCase.question,
      status: result.status,
      decision: result.decision,
      evaluated: false,
      outcome: null,
      templateFallback: null,
      validationReasons: [],
      contradictionCount: 0,
    };
    if (result.status !== "answered") {
      cases.push(base);
      continue;
    }

    // Captured in an array (not a lone variable) so strict TS doesn't narrow
    // the post-await reads to null — it can't track callback assignments.
    const outcomes: ExplainOutcome[] = [];
    // Retrieval stays out of this eval: it needs the database, and the
    // citation-binding rules the eval checks apply identically without it.
    const served = await explainEngineResult({
      question: goldenCase.question,
      result,
      onOutcome: (event) => {
        outcomes.push(event);
      },
    });
    const outcome: ExplainOutcome | null = outcomes[outcomes.length - 1] ?? null;
    const reasons = outcome?.reasons ?? [];
    cases.push({
      ...base,
      evaluated: true,
      outcome: outcome?.kind ?? null,
      templateFallback: served === renderDeterministicExplanation(result),
      validationReasons: reasons,
      contradictionCount: reasons.filter((reason) =>
        reason.startsWith("contradicts the decision")
      ).length,
    });
  }

  const evaluated = cases.filter((entry) => entry.evaluated);
  const templateFallbackCount = evaluated.filter(
    (entry) => entry.templateFallback
  ).length;
  return {
    totalCases: cases.length,
    answeredCases: cases.filter((entry) => entry.status === "answered").length,
    evaluatedCases: evaluated.length,
    templateFallbackCount,
    templateFallbackRate:
      evaluated.length === 0 ? 0 : templateFallbackCount / evaluated.length,
    decisionContradictionCount: cases.reduce(
      (sum, entry) => sum + entry.contradictionCount,
      0
    ),
    validationFailureReasons: [
      ...new Set(evaluated.flatMap((entry) => entry.validationReasons)),
    ],
    cases,
  };
}

// One human/CI-log-readable block summarizing a run.
export function formatLiveEvalReport(report: LiveEvalReport): string {
  const lines = [
    `[live-eval] ${report.evaluatedCases}/${report.totalCases} golden cases reached the model ` +
      `(${report.totalCases - report.evaluatedCases} clarify/unknown cases never invoke it).`,
    `[live-eval] template-fallback rate: ${report.templateFallbackCount}/${report.evaluatedCases} ` +
      `(${(report.templateFallbackRate * 100).toFixed(0)}%)`,
    `[live-eval] decision contradictions: ${report.decisionContradictionCount}`,
  ];
  if (report.validationFailureReasons.length > 0) {
    lines.push("[live-eval] validation-failure reasons:");
    for (const reason of report.validationFailureReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  for (const entry of report.cases.filter((c) => c.evaluated)) {
    lines.push(
      `[live-eval]   ${entry.id}: ${entry.outcome}` +
        (entry.templateFallback ? " (served template)" : "")
    );
  }
  return lines.join("\n");
}
