// Deterministic question parser: maps free-text questions onto corpus slots
// (state / category / channel) with fixed keyword tables. Deliberately NOT an
// LLM — the wedge is small, keyword coverage is auditable, and a
// deterministic parser can never hallucinate a slot. Unresolvable slots stay
// null and the engine asks a clarifying question instead of guessing.

import type { QuestionSlots } from "./schema";

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI",
  idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

// Category keywords map to corpus category slugs. Order matters: longer /
// more specific phrases first so "raw milk" wins over "milk".
const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\braw milk\b/, "raw_milk"],
  [/\bcottage (food|foods)\b/, "cottage_food"],
  [/\bacidified\b|\bpickles?\b|\bcanned\b|\bcanning\b|\bsalsa\b|\bfermented\b/, "acidified_foods"],
  [/\beggs?\b/, "eggs"],
  [/\bmeat\b|\bbeef\b|\bpork\b|\bpoultry\b|\bchicken\b|\blamb\b/, "meat"],
  [/\bjam\b|\bjell(y|ies)\b|\bbaked goods?\b|\bbread\b|\bcookies?\b/, "cottage_food"],
  // NOTE: generic "milk" / "dairy" / "cheese" deliberately map to nothing —
  // guessing raw_milk for "can I sell cheese?" would serve a cited decision
  // for the wrong category instead of asking which product they mean.
];

// Channel keywords map to corpus channel slugs. Bare "online"/"ship" map to
// nothing: selling online can be intra- or interstate, and guessing either
// would serve a cited decision for the wrong channel. Only an explicit
// marker resolves a channel.
const CHANNEL_KEYWORDS: Array<[RegExp, string]> = [
  [/\bfarmers? markets?\b/, "farmers_market"],
  [/\binterstate\b|\bacross state lines?\b|\bout[- ]of[- ]state\b|\bother states?\b/, "online_interstate"],
  [/\bintrastate\b|\bwithin (the|my) state\b/, "online_intrastate"],
  [/\bon[- ]farm\b|\bfarm stand\b|\b(on|from) (my|the) farm\b/, "on_farm"],
  [/\bwholesale\b/, "wholesale"],
  [/\bretail\b|\bgrocery\b|\bstores?\b/, "retail"],
  [/\bherd ?share\b|\bcow ?share\b/, "herdshare"],
];

export function parseQuestionSlots(question: string): QuestionSlots {
  // Normalize punctuation to spaces so "Wyoming?" and "Texas," match the
  // state table exactly like bare names do.
  const text = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;

  // Collect EVERY state mentioned. More than one ("ship from Texas to
  // Colorado") is ambiguous — resolve to none and let the engine ask which
  // state they mean, rather than silently picking the first table match.
  const states = new Set<string>();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (text.includes(` ${name} `)) states.add(code);
  }
  // Bare two-letter codes: match only uppercase in the ORIGINAL text so
  // lowercase words ("in", "me") can't resolve to states.
  for (const code of question.match(/\b([A-Z]{2})\b/g) ?? []) {
    if (STATE_CODES.has(code)) states.add(code);
  }
  const onlyState = [...states][0];
  const state = states.size === 1 && onlyState ? onlyState : null;

  let category: string | null = null;
  for (const [pattern, slug] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) {
      category = slug;
      break;
    }
  }

  let channel: string | null = null;
  for (const [pattern, slug] of CHANNEL_KEYWORDS) {
    if (pattern.test(text)) {
      channel = slug;
      break;
    }
  }

  return { state, category, channel };
}
