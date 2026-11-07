// Citation binding for the explain seam: the decision sentence is composed
// deterministically (never by the model), and any model body citing a URL
// outside the engine's evaluated rules — or contradicting the decision —
// fails closed to the deterministic template.

import {
  explainEngineResult,
  renderDeterministicExplanation,
} from "@/utils/regulations/explain";
import type { CorpusRule, EngineResult } from "@/utils/regulations/schema";

const mockCreate = jest.fn();
const mockGetClient = jest.fn();
jest.mock("@/utils/assistant/llm", () => ({
  ASSISTANT_MODEL: "test-model",
  getAnthropicClient: () => mockGetClient(),
}));

function rule(overrides: Partial<CorpusRule> = {}): CorpusRule {
  return {
    id: "r1",
    state: "CO",
    category: "raw_milk",
    channel: "on_farm",
    decision: "allowed",
    conditions: [],
    summary: "Raw milk may be sold on-farm.",
    citation_url: "https://leg.colorado.gov/statutes/raw-milk",
    citation_title: "Colorado Raw Milk Statute",
    statute_excerpt: "A producer may sell raw milk at the farm…",
    effective_date: "2021-01-01",
    last_verified_at: "2026-10-01",
    tier: "statute_verified",
    ...overrides,
  };
}

function engineResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    status: "answered",
    missing: [],
    decision: "allowed",
    tier: "statute_verified",
    reason: null,
    rules: [rule()],
    ...overrides,
  };
}

function modelSaying(text: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text }],
  });
}

describe("explainEngineResult", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGetClient.mockReset();
  });

  it("never renders an unknown result, with or without a model", async () => {
    mockGetClient.mockResolvedValueOnce(null);
    const result = engineResult({
      status: "unknown",
      decision: null,
      tier: null,
      rules: [],
    });
    await expect(
      explainEngineResult({ question: "q", result })
    ).resolves.toBe("");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("serves the deterministic template when no model credentials exist", async () => {
    mockGetClient.mockResolvedValueOnce(null);
    const text = await explainEngineResult({
      question: "q",
      result: engineResult(),
    });
    expect(text).toContain("this is allowed in CO");
    expect(text).toContain("leg.colorado.gov/statutes/raw-milk");
    expect(text).toContain("A producer may sell raw milk at the farm");
  });

  it("FAIL-CLOSED: a model-invented citation URL drops the answer to the template", async () => {
    mockGetClient.mockResolvedValueOnce({
      messages: { create: mockCreate },
    });
    modelSaying(
      "The statute says this is allowed. See https://example.com/fake-law for details."
    );
    const text = await explainEngineResult({
      question: "q",
      result: engineResult(),
    });
    expect(text).toContain("A producer may sell raw milk at the farm");
    expect(text).not.toContain("example.com");
  });

  it("FAIL-CLOSED: a retrieved-context URL is NOT citable — only evaluated rules are", async () => {
    mockGetClient.mockResolvedValueOnce({
      messages: { create: mockCreate },
    });
    modelSaying(
      "The guidance adds detail. https://agency.example.gov/unevaluated-guidance"
    );
    const text = await explainEngineResult({
      question: "q",
      result: engineResult(),
      retrieved: [
        {
          ruleId: "r2",
          citationUrl: "https://agency.example.gov/unevaluated-guidance",
          citationTitle: "Unevaluated guidance",
          summary: "s",
          excerpt: "e",
          score: 1,
        },
      ],
    });
    expect(text).not.toContain("agency.example.gov");
    expect(text).toContain("leg.colorado.gov/statutes/raw-milk");
  });

  it("FAIL-CLOSED: a prohibition answered with 'you can sell' drops to the template", async () => {
    mockGetClient.mockResolvedValueOnce({
      messages: { create: mockCreate },
    });
    modelSaying(
      "You can sell this freely. https://leg.colorado.gov/statutes/raw-milk"
    );
    const text = await explainEngineResult({
      question: "q",
      result: engineResult({
        decision: "prohibited",
        rules: [rule({ decision: "prohibited" })],
      }),
    });
    expect(text).toContain("this is prohibited in CO");
    expect(text).not.toContain("freely");
  });

  it("FAIL-CLOSED: advisory phrasing ('you should') drops the model body to the template", async () => {
    mockGetClient.mockResolvedValueOnce({
      messages: { create: mockCreate },
    });
    // The prompt forbids advice, but a prompt is a request, not a guarantee —
    // the output validator must reject it on the production model path too.
    modelSaying(
      "The statute allows this. You should apply for the license early. https://leg.colorado.gov/statutes/raw-milk"
    );
    const text = await explainEngineResult({
      question: "q",
      result: engineResult(),
    });
    expect(text).not.toContain("You should");
    expect(text).toContain("A producer may sell raw milk at the farm");
  });

  it("serves the deterministic decision sentence ahead of a valid model body", async () => {
    mockGetClient.mockResolvedValueOnce({
      messages: { create: mockCreate },
    });
    modelSaying(
      "The statute says on-farm sales by the producer qualify. https://leg.colorado.gov/statutes/raw-milk"
    );
    const text = await explainEngineResult({
      question: "q",
      result: engineResult(),
    });
    expect(text.startsWith("Based on the cited statute, this is allowed in CO.")).toBe(true);
    expect(text).toContain("on-farm sales by the producer qualify");
  });

  it("renderDeterministicExplanation lists conditions for conditional decisions", () => {
    const conditionalRule: CorpusRule = rule({
      decision: "conditional",
      conditions: ["sales must occur on the farm"],
    });
    const text = renderDeterministicExplanation(
      engineResult({
        decision: "conditional",
        rules: [conditionalRule],
      })
    );
    expect(text).toContain("is allowed only under conditions");
    expect(text).toContain("sales must occur on the farm");
  });
});
