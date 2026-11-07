// Regulation-graph domain schema. The corpus is DATA: every rule row is
// validated against these schemas before the engine may use it, and a row
// without a real citation never validates — a rule we cannot cite is a rule
// we cannot serve. This module is dependency-light (zod only) so the engine
// and parser stay unit-testable without a database or an LLM.

import { z } from "zod";

// Confidence tiers (docs/producer-platform-plan.md): statute-verified means
// the row is backed by statutory/regulatory text; agency-guidance means an
// agency interpretation (FAQ, guidance PDF); anything else is UNKNOWN and
// must never be answered — the user gets the agency contact path instead.
export const CONFIDENCE_TIERS = ["statute_verified", "agency_guidance"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

// What the rule says about the state × category × channel slot. "conditional"
// = allowed only if the listed conditions are met.
export const RULE_DECISIONS = ["allowed", "conditional", "prohibited"] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];

// Wedge coverage (P0). Kept as open slug strings rather than a closed enum so
// corpus expansion (P2: 50 states, more categories) never needs a code change
// — but always lowercase-slug-shaped so lookups can't drift on casing.
const SLUG = /^[a-z][a-z0-9_]*$/;

export const corpusRuleSchema = z
  .object({
    id: z.string().min(1),
    // US state / jurisdiction code, uppercase two letters (DC included).
    state: z.string().regex(/^[A-Z]{2}$/),
    category: z.string().regex(SLUG),
    channel: z.string().regex(SLUG),
    decision: z.enum(RULE_DECISIONS),
    // Human-readable conditions that gate a "conditional" decision, e.g.
    // "annual gross sales must not exceed $10,000". Always an array.
    conditions: z.array(z.string().min(1)),
    // One-sentence statement of what the cited source says.
    summary: z.string().min(1),
    // Rawest-source citation only (statute, eCFR, agency rule/guidance PDF).
    citation_url: z.string().regex(/^https?:\/\//),
    citation_title: z.string().min(1),
    // Verbatim excerpt of the controlling text the decision rests on.
    statute_excerpt: z.string().min(1),
    effective_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    last_verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tier: z.enum(CONFIDENCE_TIERS),
  })
  .strict();
export type CorpusRule = z.infer<typeof corpusRuleSchema>;

// Where "unknown" answers send the user. category is null for the
// state-level default contact.
export const agencyContactSchema = z
  .object({
    state: z.string().regex(/^[A-Z]{2}$/),
    category: z.string().regex(SLUG).nullable(),
    agency_name: z.string().min(1),
    contact_url: z.string().regex(/^https?:\/\//),
    phone: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
  })
  .strict();
export type AgencyContact = z.infer<typeof agencyContactSchema>;

// Structured slots the deterministic parser extracts from a question. Any
// slot may be absent; the engine answers only from what it can resolve.
export interface QuestionSlots {
  state: string | null;
  category: string | null;
  channel: string | null;
}

export type EngineStatus =
  // Slots were too vague to look anything up — ask for the missing slot.
  | "clarify"
  // A matrix-backed decision exists; the LLM may explain but never change it.
  | "answered"
  // No corpus backing for the resolved slot combination. Fail closed: the
  // only honest output is the agency contact path.
  | "unknown";

export interface EngineResult {
  status: EngineStatus;
  // Which slots are missing when status === "clarify". "channel" is missing
  // when the corpus covers the state × category but its channels disagree on
  // the decision — aggregating them would serve a materially wrong answer.
  missing: Array<"state" | "category" | "channel">;
  // Overall decision across the matching rules: the most restrictive wins
  // (prohibited > conditional > allowed), because serving the permissive
  // reading while a stricter rule matches would be a silent compliance hole.
  decision: RuleDecision | null;
  // Min tier across supporting rules — one guidance-backed link drags the
  // answer from statute_verified to agency_guidance.
  tier: ConfidenceTier | null;
  // The rules the decision rests on. Every citation the chat may show comes
  // from this list and nowhere else.
  rules: CorpusRule[];
  // Loud, machine-checkable reason whenever status !== "answered".
  reason: string | null;
}

export const LEGAL_INFORMATION_DISCLAIMER =
  "This is legal information from cited sources, not legal advice. Confirm requirements with the agency listed before you sell.";
