// Chat orchestration for the wedge. One function, fully injectable, so the
// fail-closed contract is unit-testable without a database or a model:
//   - the decision comes from evaluateMatrix over store rows, never the LLM;
//   - unknown ⇒ agency contact path, and the model is never invoked;
//   - clarify ⇒ ask for the missing slot, no retrieval, no model.

import { evaluateMatrix } from "./engine";
import { explainEngineResult } from "./explain";
import { parseQuestionSlots } from "./question-parser";
import {
  LEGAL_INFORMATION_DISCLAIMER,
  type AgencyContact,
  type EngineResult,
} from "./schema";
import type { RetrievedExcerpt } from "./store";

export interface RegulationsChatDeps {
  fetchCorpusRules(state: string, category: string): Promise<import("./schema").CorpusRule[]>;
  fetchAgencyContact(state: string, category: string | null): Promise<AgencyContact | null>;
  retrieveExcerpts(params: {
    state: string | null;
    category: string | null;
    query: string;
  }): Promise<RetrievedExcerpt[]>;
  explain(input: {
    question: string;
    result: EngineResult;
    retrieved: RetrievedExcerpt[];
  }): Promise<string>;
}

export interface RegulationsChatAnswer {
  status: EngineResult["status"];
  // Present on answered: the engine's decision and tier.
  decision: EngineResult["decision"];
  tier: EngineResult["tier"];
  // The user-facing text: model explanation (validated) or template on
  // answered; the missing-slot question on clarify; the agency path on
  // unknown.
  message: string;
  citations: Array<{ url: string; title: string }>;
  agencyContact: AgencyContact | null;
  disclaimer: string;
}

const GENERIC_AGENCY_NOTE =
  "Your state department of agriculture is the authoritative contact for this question.";

export async function answerRegulationQuestion(
  question: string,
  deps: RegulationsChatDeps
): Promise<RegulationsChatAnswer> {
  const slots = parseQuestionSlots(question);
  const base = {
    decision: null,
    tier: null,
    citations: [] as Array<{ url: string; title: string }>,
    agencyContact: null,
    disclaimer: LEGAL_INFORMATION_DISCLAIMER,
  };

  const rules =
    slots.state && slots.category
      ? await deps.fetchCorpusRules(slots.state, slots.category)
      : [];
  const result = evaluateMatrix(slots, rules);

  if (result.status === "clarify") {
    const asks: string[] = [];
    if (result.missing.includes("state")) {
      asks.push("which state you'd be selling in");
    }
    if (result.missing.includes("category")) {
      asks.push(
        "the product category (for example: cottage food, raw milk, eggs, meat, or acidified foods)"
      );
    }
    return {
      ...base,
      status: "clarify",
      message: `To check the cited rules, I need ${asks.join(" and ")}. I only answer from verified statute and agency sources — if your state or product isn't covered yet, I'll point you to the right agency instead of guessing.`,
    };
  }

  if (result.status === "unknown") {
    const contact = slots.state
      ? await deps.fetchAgencyContact(slots.state, slots.category)
      : null;
    const contactLine = contact
      ? `${contact.agency_name}: ${contact.contact_url}${contact.phone ? ` — ${contact.phone}` : ""}${contact.email ? ` — ${contact.email}` : ""}`
      : GENERIC_AGENCY_NOTE;
    return {
      ...base,
      status: "unknown",
      agencyContact: contact,
      message:
        "I don't have a verified source covering that question, so I won't guess. " +
        `The right next step is to ask the regulator directly — ${contactLine}`,
    };
  }

  // answered: explain with citations. Retrieval pulls related corpus excerpts
  // as extra context for the explainer; failure here must never block an
  // engine-backed answer.
  let retrieved: RetrievedExcerpt[] = [];
  try {
    retrieved = await deps.retrieveExcerpts({
      state: slots.state,
      category: slots.category,
      query: question,
    });
  } catch (error) {
    console.warn(
      "[regulations] retrieval failed; explaining from engine rules only:",
      error instanceof Error ? error.message : error
    );
  }
  let message: string;
  try {
    message = await deps.explain({ question, result, retrieved });
  } catch (error) {
    console.warn(
      "[regulations] explainer threw; serving engine result only:",
      error instanceof Error ? error.message : error
    );
    message = "";
  }
  if (!message) {
    // Belt and suspenders: explainEngineResult already falls back to the
    // template, but an answer is never allowed to come back empty.
    const { renderDeterministicExplanation } = await import("./explain");
    message = renderDeterministicExplanation(result);
  }

  return {
    ...base,
    status: "answered",
    decision: result.decision,
    tier: result.tier,
    message,
    citations: result.rules.map((rule) => ({
      url: rule.citation_url,
      title: rule.citation_title,
    })),
  };
}

// Production deps wiring (the route uses these; tests inject stubs).
export function productionDeps(): RegulationsChatDeps {
  return {
    fetchCorpusRules: (state, category) =>
      import("./store").then((m) => m.fetchCorpusRules(state, category)),
    fetchAgencyContact: (state, category) =>
      import("./store").then((m) => m.fetchAgencyContact(state, category)),
    retrieveExcerpts: async ({ state, category, query }) => {
      const [{ retrieveCorpusExcerpts }, { embedCorpusText }] =
        await Promise.all([import("./store"), import("./embeddings")]);
      const embedding = await embedCorpusText(query);
      return retrieveCorpusExcerpts({ state, category, query, embedding });
    },
    explain: (input) => explainEngineResult(input),
  };
}
