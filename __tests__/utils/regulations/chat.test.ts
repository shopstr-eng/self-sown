// The fail-closed contract, proven end to end at the orchestration layer:
// an answer with no corpus backing cannot be produced — the model is never
// invoked on the unknown path, and the user gets the agency contact.

import {
  answerRegulationQuestion,
  type RegulationsChatDeps,
} from "@/utils/regulations/chat";
import type { CorpusRule } from "@/utils/regulations/schema";

const CO_RAW_MILK: CorpusRule = {
  id: "rule-1",
  state: "CO",
  category: "raw_milk",
  channel: "on_farm",
  decision: "conditional",
  conditions: ["sales must occur on the farm"],
  summary: "Raw milk may be sold on-farm.",
  citation_url: "https://leg.colorado.gov/statutes/raw-milk",
  citation_title: "Colorado Raw Milk Statute",
  statute_excerpt: "A producer may sell raw milk at the farm…",
  effective_date: "2021-01-01",
  last_verified_at: "2026-10-01",
  tier: "statute_verified",
};

function deps(overrides: Partial<RegulationsChatDeps> = {}) {
  const explain = jest.fn(async () => "The statute says it is conditional. https://leg.colorado.gov/statutes/raw-milk");
  const retrieveExcerpts = jest.fn(async () => []);
  const fetchAgencyContact = jest.fn(async () => ({
    state: "WY",
    category: null,
    agency_name: "Wyoming Department of Agriculture",
    contact_url: "https://agriculture.wy.gov/",
    phone: null,
    email: null,
  }));
  return {
    fetchCorpusRules: jest.fn(async () => [CO_RAW_MILK]),
    fetchAgencyContact,
    retrieveExcerpts,
    explain,
    ...overrides,
  };
}

describe("answerRegulationQuestion", () => {
  it("answers from matrix data with citations; the decision comes from the engine", async () => {
    const d = deps();
    const answer = await answerRegulationQuestion(
      "Can I sell raw milk in Colorado on my farm?",
      d
    );
    expect(answer.status).toBe("answered");
    expect(answer.decision).toBe("conditional");
    expect(answer.tier).toBe("statute_verified");
    expect(answer.citations).toEqual([
      {
        url: "https://leg.colorado.gov/statutes/raw-milk",
        title: "Colorado Raw Milk Statute",
      },
    ]);
    expect(answer.disclaimer).toContain("not legal advice");
    expect(d.explain).toHaveBeenCalledTimes(1);
    // The explainer receives the engine result — it never recomputes one.
    expect((d.explain as jest.Mock).mock.calls[0][0].result.decision).toBe("conditional");
  });

  it("FAIL-CLOSED: no corpus backing ⇒ unknown, agency contact, model never called", async () => {
    const d = deps({ fetchCorpusRules: jest.fn(async () => []) });
    const answer = await answerRegulationQuestion(
      "Can I sell raw milk in Wyoming?",
      d
    );
    expect(answer.status).toBe("unknown");
    expect(answer.decision).toBeNull();
    expect(answer.citations).toEqual([]);
    expect(answer.agencyContact?.agency_name).toBe(
      "Wyoming Department of Agriculture"
    );
    expect(answer.message).toContain("won't guess");
    expect(d.explain).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: uncovered channel ⇒ unknown even when the category has rules", async () => {
    const d = deps();
    const answer = await answerRegulationQuestion(
      "Can I ship raw milk to other states from Colorado?",
      d
    );
    expect(answer.status).toBe("unknown");
    expect(d.explain).not.toHaveBeenCalled();
  });

  it("asks a clarifying question when slots are missing, without retrieval or the model", async () => {
    const d = deps();
    const answer = await answerRegulationQuestion("what are the rules?", d);
    expect(answer.status).toBe("clarify");
    expect(answer.message).toContain("which state");
    expect(d.explain).not.toHaveBeenCalled();
    expect(d.retrieveExcerpts).not.toHaveBeenCalled();
    expect(d.fetchCorpusRules).not.toHaveBeenCalled();
  });

  it("serves an engine-backed answer even when retrieval and the explainer both fail", async () => {
    const d = deps({
      retrieveExcerpts: jest.fn(async () => {
        throw new Error("db down");
      }),
      explain: jest.fn(async () => {
        throw new Error("model down");
      }),
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const answer = await answerRegulationQuestion(
      "Can I sell raw milk in Colorado on my farm?",
      d
    );
    expect(answer.status).toBe("answered");
    expect(answer.decision).toBe("conditional");
    // The deterministic template carries the excerpt and citation.
    expect(answer.message).toContain("leg.colorado.gov/statutes/raw-milk");
    warn.mockRestore();
  });
});
