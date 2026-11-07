// The deterministic rule engine. This is the ONLY component allowed to make
// a compliance decision: it reads matrix rows (data) and returns an
// EngineResult. The LLM never runs in this path — it only explains what this
// engine already decided. Fail-closed, loud on unknown: any slot combination
// with no corpus backing returns "unknown" plus the agency-contact path, and
// logs a marker so missing coverage is visible rather than silent.

import type { CorpusRule, EngineResult, QuestionSlots, RuleDecision } from "./schema";

const RESTRICTIVENESS: Record<RuleDecision, number> = {
  allowed: 0,
  conditional: 1,
  prohibited: 2,
};

function mostRestrictive(rules: CorpusRule[]): RuleDecision {
  return rules.reduce<RuleDecision>(
    (worst, rule) =>
      RESTRICTIVENESS[rule.decision] > RESTRICTIVENESS[worst]
        ? rule.decision
        : worst,
    "allowed"
  );
}

function minTier(rules: CorpusRule[]): CorpusRule["tier"] {
  return rules.some((rule) => rule.tier === "agency_guidance")
    ? "agency_guidance"
    : "statute_verified";
}

function unknown(reason: string, slots: QuestionSlots): EngineResult {
  // Loud on unknown: coverage gaps must be greppable in logs, not invisible
  // in a chat transcript.
  console.warn("[regulations] UNKNOWN answer (fail-closed)", {
    reason,
    state: slots.state,
    category: slots.category,
    channel: slots.channel,
  });
  return {
    status: "unknown",
    missing: [],
    decision: null,
    tier: null,
    rules: [],
    reason,
  };
}

/**
 * Evaluate a question's resolved slots against the corpus rules for its
 * state + category. Pure function — the caller fetches `rules` from the
 * store; the engine never touches I/O.
 *
 * Rules passed in must already be schema-validated corpus rows for the
 * question's state + category (all channels). The engine applies the channel
 * filter itself so the "channel not covered" case stays distinguishable from
 * "category not covered at all".
 */
export function evaluateMatrix(
  slots: QuestionSlots,
  rules: CorpusRule[]
): EngineResult {
  const missing: Array<"state" | "category"> = [];
  if (!slots.state) missing.push("state");
  if (!slots.category) missing.push("category");
  if (missing.length > 0) {
    return {
      status: "clarify",
      missing,
      decision: null,
      tier: null,
      rules: [],
      reason: null,
    };
  }

  if (rules.length === 0) {
    return unknown("no_corpus_for_state_category", slots);
  }

  let matching = rules;
  if (slots.channel) {
    matching = rules.filter((rule) => rule.channel === slots.channel);
    if (matching.length === 0) {
      // The category is covered but this channel isn't. Never extrapolate a
      // decision from a sibling channel — that's how sellers get fined.
      return unknown("channel_not_covered", slots);
    }
  } else {
    // No channel resolved: only answer when every covered channel agrees on
    // the decision. Channels routinely disagree (direct sales allowed but
    // interstate prohibited), and aggregating them into one most-restrictive
    // verdict would tell a farmer their lawful farmers-market jam is
    // "prohibited" — materially wrong. Ask for the channel instead.
    const byChannel = new Map<string, CorpusRule[]>();
    for (const rule of matching) {
      const group = byChannel.get(rule.channel) ?? [];
      group.push(rule);
      byChannel.set(rule.channel, group);
    }
    const channelDecisions = new Set(
      [...byChannel.values()].map((channelRules) => mostRestrictive(channelRules))
    );
    if (channelDecisions.size > 1) {
      return {
        status: "clarify",
        missing: ["channel"],
        decision: null,
        tier: null,
        rules: [],
        reason: null,
      };
    }
  }

  return {
    status: "answered",
    missing: [],
    decision: mostRestrictive(matching),
    tier: minTier(matching),
    rules: matching,
    reason: null,
  };
}
