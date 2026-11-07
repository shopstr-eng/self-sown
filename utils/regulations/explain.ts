// The explain seam — the ONLY place the LLM touches a regulation answer.
// The engine (utils/regulations/engine.ts) has already decided; this module's
// job is to phrase that decision with its citations. Hard rules:
//   1. UNKNOWN results never reach the model — there is nothing to explain,
//      and a model facing an unknown will try to be helpful (i.e. guess).
//   2. The decision sentence is deterministic — composed here, never by the
//      model. The model may only write the explanatory body after it, and
//      that body is validated before serving: every URL must come from the
//      engine's evaluated rule set (retrieved context is quotable in the
//      prompt but NEVER citable), and the body must not contradict the
//      decision. Any failure falls back to the deterministic template.
//   3. No credentials / any model error → the same deterministic template.
// The template is not a degraded mode; it is the guaranteed floor.

import { getAnthropicClient, ASSISTANT_MODEL } from "@/utils/assistant/llm";
import { ADVISORY_PHRASING } from "./golden-set";
import type { CorpusRule, EngineResult } from "./schema";
import type { RetrievedExcerpt } from "./store";

// What happened on one explain call. Production ignores it; the live eval
// (utils/regulations/live-explain-eval.ts) consumes it to report
// template-fallback rate and validation-failure reasons against the real
// model, which the fallback path otherwise swallows silently.
export type ExplainOutcomeKind =
  | "not_answered" // clarify/unknown — the model is never invoked
  | "no_client" // no credentials / SDK unavailable → template
  | "model_accepted" // body passed validation and was served
  | "validation_failed" // body rejected → template
  | "model_error"; // API threw → template

export interface ExplainOutcome {
  kind: ExplainOutcomeKind;
  // The model's raw body when one was produced.
  body?: string;
  // Why the body was rejected (validation_failed only).
  reasons?: string[];
}

export interface ExplanationInput {
  question: string;
  result: EngineResult; // status === "answered" only — enforced below
  // Additional corpus excerpts pulled by retrieval for context. They are
  // quoted to the model as background but are NOT added to the citable set —
  // only rules the engine actually evaluated may appear as citations.
  retrieved?: RetrievedExcerpt[];
  onOutcome?: (outcome: ExplainOutcome) => void;
}

const DECISION_PHRASES: Record<string, string> = {
  allowed: "is allowed",
  conditional: "is allowed only under conditions",
  prohibited: "is prohibited",
};

// The decision sentence is always composed deterministically from the
// engine's result. An answered result always carries at least one rule.
function decisionSentence(result: EngineResult): string {
  const rule = result.rules[0] as CorpusRule;
  const phrase = DECISION_PHRASES[result.decision ?? "conditional"];
  const source =
    result.tier === "statute_verified" ? "statute" : "agency guidance";
  return `Based on the cited ${source}, this ${phrase} in ${rule.state}.`;
}

// Deterministic rendering of an engine decision. Every citation comes from
// result.rules — the same set the model's body is restricted to.
export function renderDeterministicExplanation(result: EngineResult): string {
  if (result.status !== "answered" || !result.decision) return "";
  const lines: string[] = [decisionSentence(result)];
  for (const rule of result.rules) {
    lines.push(
      `\nThe source says: "${rule.statute_excerpt}" — ${rule.citation_title} (${rule.citation_url})`
    );
    if (rule.decision === "conditional" && rule.conditions.length > 0) {
      lines.push("Conditions listed in the source:");
      for (const condition of rule.conditions) {
        lines.push(`- ${condition}`);
      }
    }
  }
  return lines.join("\n");
}

// Extract every http(s) URL the model emitted; each must be one the engine
// provided. A model that invents a citation fails closed to the template.
function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
}

// Phrases that contradict each decision. Conservative on purpose: when in
// doubt, serve the template.
const CONTRADICTIONS: Record<string, RegExp> = {
  allowed:
    /\b(prohibited|illegal|not allowed|banned|against the law|not permitted|can(?:not|'t) sell)\b/,
  conditional: /\b(prohibited|illegal|banned|against the law)\b/,
  prohibited:
    /\bis (legal|allowed|permitted)\b|\byou can (sell|offer|ship)\b|\bfeel free\b|\bgo ahead\b/,
};

// The body validator, exported so the live eval can report WHY the model's
// body was rejected instead of only observing the fallback. An empty reasons
// list means the body is servable.
export function validateExplanationBody(
  text: string,
  result: EngineResult
): string[] {
  const reasons: string[] = [];
  if (!text) reasons.push("model returned an empty body");
  if (text.length > 4_000) reasons.push("body exceeds 4,000 characters");
  // The prompt forbids advice, but a prompt is a request, not a guarantee:
  // a body telling the seller what to do fails closed to the template.
  const advisory = text.match(ADVISORY_PHRASING);
  if (advisory) reasons.push(`advisory phrasing ("${advisory[0]}")`);
  const allowedUrls = new Set(result.rules.map((rule) => rule.citation_url));
  let citesEngineRule = false;
  for (const url of extractUrls(text)) {
    const cleaned = url.replace(/[.,;:]+$/, "");
    if (!allowedUrls.has(cleaned)) {
      reasons.push(`cites a URL outside the engine's rules: ${cleaned}`);
      continue;
    }
    citesEngineRule = true;
  }
  // A body with no citation at all is not an answer we serve.
  if (!citesEngineRule) reasons.push("body cites no engine-rule URL");
  if (!result.decision) {
    reasons.push("engine result carries no decision");
  } else {
    const contradiction = CONTRADICTIONS[result.decision];
    const hit = contradiction?.exec(text.toLowerCase());
    if (hit) reasons.push(`contradicts the decision ("${hit[0]}")`);
  }
  return reasons;
}

export async function explainEngineResult(
  input: ExplanationInput
): Promise<string> {
  const { result } = input;
  if (result.status !== "answered") {
    // Hard rule 1: unknown/clarify results are rendered by the caller, never
    // by the model.
    input.onOutcome?.({ kind: "not_answered" });
    return "";
  }

  const fallback = renderDeterministicExplanation(result);
  const client = await getAnthropicClient();
  if (!client) {
    input.onOutcome?.({ kind: "no_client" });
    return fallback;
  }

  const sourceBlock = result.rules
    .map(
      (rule, i) =>
        `SOURCE ${i + 1}\nDecision: ${rule.decision}\nSummary: ${rule.summary}\nExcerpt: "${rule.statute_excerpt}"\nCitation: ${rule.citation_title} — ${rule.citation_url}\nTier: ${rule.tier}\nLast verified: ${rule.last_verified_at}`
    )
    .join("\n\n");
  const retrieved = input.retrieved ?? [];
  const retrievedBlock = retrieved
    .map(
      (excerpt, i) =>
        `CONTEXT ${i + 1}\nExcerpt: "${excerpt.excerpt}"\nSource title: ${excerpt.citationTitle}`
    )
    .join("\n\n");

  try {
    const response = await client.messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: 800,
      system:
        "You write the explanatory body for a food-regulation answer whose decision sentence has already been written by a deterministic rule engine from cited statutes. " +
        "The decision sentence is shown to the user verbatim BEFORE your text — never restate, soften, strengthen, or contradict the decision, and never add requirements. " +
        "You may only explain what the SOURCES below say, in plain language, phrased as 'the statute says X'. Never say what the user should do. " +
        "You may cite ONLY the exact citation URLs listed under SOURCES. CONTEXT excerpts are background: never quote their URLs. " +
        "Keep it under 120 words.",
      messages: [
        {
          role: "user",
          content: `Question: ${input.question}\n\nDecision sentence already shown (do not repeat or contradict): "${decisionSentence(result)}"\nEngine decision: ${result.decision} (tier: ${result.tier})\n\n${sourceBlock}${retrievedBlock ? `\n\nBackground context (NOT citable):\n${retrievedBlock}` : ""}`,
        },
      ],
    });
    const text = Array.isArray(response?.content)
      ? response.content
          .filter((block: { type?: string }) => block?.type === "text")
          .map((block: { text?: string }) => block.text ?? "")
          .join("")
      : "";
    // The deterministic decision sentence always leads; the model body only
    // supplements it, and only when it passes validation.
    const reasons = validateExplanationBody(text, result);
    if (reasons.length === 0) {
      input.onOutcome?.({ kind: "model_accepted", body: text });
      return `${decisionSentence(result)}\n\n${text}`;
    }
    input.onOutcome?.({ kind: "validation_failed", body: text, reasons });
    return fallback;
  } catch (error) {
    console.warn(
      "[regulations] explanation fell back to template:",
      error instanceof Error ? error.message : error
    );
    input.onOutcome?.({ kind: "model_error" });
    return fallback;
  }
}
