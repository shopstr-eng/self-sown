import { evaluateMatrix } from "@/utils/regulations/engine";
import {
  corpusRuleSchema,
  type CorpusRule,
} from "@/utils/regulations/schema";

function rule(overrides: Partial<CorpusRule> = {}): CorpusRule {
  return {
    id: "rule-1",
    state: "CO",
    category: "raw_milk",
    channel: "on_farm",
    decision: "allowed",
    conditions: [],
    summary: "Raw milk sales are permitted on the farm.",
    citation_url: "https://leg.colorado.gov/statutes/raw-milk",
    citation_title: "Colorado Raw Milk Statute",
    statute_excerpt: "A producer may sell raw milk at the farm…",
    effective_date: "2021-01-01",
    last_verified_at: "2026-10-01",
    tier: "statute_verified",
    ...overrides,
  };
}

describe("evaluateMatrix", () => {
  it("answers from matrix data with the rule's decision and tier", () => {
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: "on_farm" },
      [rule()]
    );
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("allowed");
    expect(result.tier).toBe("statute_verified");
    expect(result.rules).toHaveLength(1);
  });

  it("fails closed when no corpus rows back the slot", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = evaluateMatrix(
      { state: "WY", category: "raw_milk", channel: "on_farm" },
      []
    );
    expect(result.status).toBe("unknown");
    expect(result.decision).toBeNull();
    expect(result.reason).toBe("no_corpus_for_state_category");
    expect(warn).toHaveBeenCalledWith(
      "[regulations] UNKNOWN answer (fail-closed)",
      expect.objectContaining({ state: "WY" })
    );
    warn.mockRestore();
  });

  it("never extrapolates a decision to an uncovered channel", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: "online_interstate" },
      [rule()]
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("channel_not_covered");
    warn.mockRestore();
  });

  it("aggregates to the most restrictive decision within the resolved channel", () => {
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: "on_farm" },
      [
        rule({ id: "r1", decision: "allowed" }),
        rule({ id: "r2", decision: "conditional" }),
      ]
    );
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("conditional");
    expect(result.rules).toHaveLength(2);
  });

  it("clarifies the channel instead of aggregating channels that disagree", () => {
    // With no channel resolved, mixing "allowed on-farm" with "prohibited at
    // retail" into one most-restrictive verdict would call a lawful direct
    // sale prohibited — materially wrong. Ask which channel instead.
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: null },
      [
        rule({ id: "r1", decision: "allowed" }),
        rule({ id: "r2", decision: "prohibited", channel: "retail" }),
        rule({ id: "r3", decision: "conditional", channel: "farmers_market" }),
      ]
    );
    expect(result.status).toBe("clarify");
    expect(result.missing).toEqual(["channel"]);
    expect(result.decision).toBeNull();
    expect(result.rules).toHaveLength(0);
  });

  it("answers without a channel when every covered channel agrees", () => {
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: null },
      [
        rule({ id: "r1", decision: "prohibited" }),
        rule({ id: "r2", decision: "prohibited", channel: "retail" }),
        rule({ id: "r3", decision: "prohibited", channel: "farmers_market" }),
      ]
    );
    expect(result.status).toBe("answered");
    expect(result.decision).toBe("prohibited");
    expect(result.rules).toHaveLength(3);
  });

  it("drags the tier down to agency_guidance when any supporting rule is guidance", () => {
    const result = evaluateMatrix(
      { state: "CO", category: "raw_milk", channel: null },
      [rule({ id: "r1" }), rule({ id: "r2", tier: "agency_guidance" })]
    );
    expect(result.tier).toBe("agency_guidance");
  });

  it("asks for missing slots instead of guessing", () => {
    const result = evaluateMatrix(
      { state: null, category: "eggs", channel: null },
      []
    );
    expect(result.status).toBe("clarify");
    expect(result.missing).toEqual(["state"]);
  });
});

describe("corpusRuleSchema", () => {
  it("rejects a row without a real citation URL", () => {
    const { citation_url, ...noCitation } = rule();
    expect(citation_url).toBeDefined();
    expect(corpusRuleSchema.safeParse(noCitation).success).toBe(false);
    expect(
      corpusRuleSchema.safeParse(rule({ citation_url: "not-a-url" })).success
    ).toBe(false);
  });

  it("rejects empty excerpts and unknown tiers", () => {
    expect(corpusRuleSchema.safeParse(rule({ statute_excerpt: "" })).success).toBe(false);
    expect(
      corpusRuleSchema.safeParse(rule({ tier: "blog_post" as never })).success
    ).toBe(false);
  });

  it("rejects lowercase state codes so lookups can't drift on casing", () => {
    expect(corpusRuleSchema.safeParse(rule({ state: "co" })).success).toBe(false);
  });
});
