// The golden Q&A eval comparator — the CI trust gate for the regulation
// wedge (docs/producer-platform-plan.md, P0 trust gates). The case data and
// launch gate live in ./golden-set (dependency-free so the page and API
// route can gate on it); this module runs each case through the full
// deterministic pipeline (parse → engine → template render → disclaimer)
// and reports every drift from the attorney-reviewable expectation.
//
// The eval runs with no LLM and no database: the model may only supplement
// the deterministic floor, so what CI can and must prove is the floor
// itself. The model path's output validator (./explain) enforces the same
// advisory-phrasing ban, guarded by explain.test.ts with a mocked model.

import { WEDGE_AGENCY_CONTACTS, WEDGE_CORPUS } from "./corpus";
import { answerRegulationQuestion, type RegulationsChatDeps } from "./chat";
import { renderDeterministicExplanation } from "./explain";
import {
  ADVISORY_PHRASING,
  type GoldenCase,
} from "./golden-set";
import type { CorpusRule } from "./schema";

export { GOLDEN_CASES } from "./golden-set";
export type { GoldenCase, GoldenReview } from "./golden-set";

export interface GoldenCaseOutcome {
  pass: boolean;
  failures: string[];
}

function wedgeDeps(rules: CorpusRule[]): RegulationsChatDeps {
  return {
    fetchCorpusRules: async (state, category) =>
      rules.filter(
        (rule) => rule.state === state && rule.category === category
      ),
    fetchAgencyContact: async (state, category) =>
      WEDGE_AGENCY_CONTACTS.find(
        (contact) =>
          contact.state === state &&
          (contact.category === category || contact.category === null)
      ) ?? null,
    // CI never calls the model or the vector store: the deterministic
    // template is the guaranteed floor, and that floor is what the golden
    // set pins.
    retrieveExcerpts: async () => [],
    explain: async ({ result }) => renderDeterministicExplanation(result),
  };
}

/**
 * Run one golden case through the full deterministic pipeline and return
 * every way the answer drifted from the attorney-reviewable expectation.
 * Pure with respect to the outside world: the corpus rows can be swapped by
 * the caller, which is how the deliberate-break tests prove CI would catch a
 * corpus or engine change that breaks a golden answer.
 */
export async function runGoldenCase(
  goldenCase: GoldenCase,
  rules: CorpusRule[] = WEDGE_CORPUS
): Promise<GoldenCaseOutcome> {
  const failures: string[] = [];
  const answer = await answerRegulationQuestion(
    goldenCase.question,
    wedgeDeps(rules)
  );
  const label = `golden case ${goldenCase.id}`;

  if (answer.status !== goldenCase.expect.status) {
    failures.push(
      `${label}: status ${answer.status} !== expected ${goldenCase.expect.status}`
    );
  }

  if (goldenCase.expect.status === "answered") {
    if (answer.decision !== goldenCase.expect.decision) {
      failures.push(
        `${label}: decision ${answer.decision} !== expected ${goldenCase.expect.decision}`
      );
    }
    if (
      goldenCase.expect.tier &&
      answer.tier !== goldenCase.expect.tier
    ) {
      failures.push(
        `${label}: tier ${answer.tier} !== expected ${goldenCase.expect.tier}`
      );
    }
    for (const fragment of goldenCase.expect.citationUrlIncludes ?? []) {
      if (!answer.citations.some((citation) => citation.url.includes(fragment))) {
        failures.push(`${label}: no citation URL contains "${fragment}"`);
      }
    }
    for (const citation of answer.citations) {
      if (!/^https?:\/\//.test(citation.url)) {
        failures.push(`${label}: non-http(s) citation served: ${citation.url}`);
      }
    }
  }

  for (const fragment of goldenCase.expect.messageIncludes ?? []) {
    if (!answer.message.includes(fragment)) {
      failures.push(`${label}: message does not include "${fragment}"`);
    }
  }

  // Universal invariants on every served answer, whatever the status.
  if (!answer.disclaimer.includes("not legal advice")) {
    failures.push(`${label}: disclaimer lost the not-legal-advice framing`);
  }
  if (ADVISORY_PHRASING.test(answer.message)) {
    failures.push(
      `${label}: message uses advisory phrasing ("${answer.message.match(ADVISORY_PHRASING)?.[0]}") — answers state what the source says, never what to do`
    );
  }

  return { pass: failures.length === 0, failures };
}
