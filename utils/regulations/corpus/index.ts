// The wedge corpus: 2 states × 3 categories, chosen from where sellers
// actually are (decision record: docs/regulations-wedge-decision.md).
//
// REVIEW STATUS: PENDING ATTORNEY REVIEW. These matrices must be validated by
// a food-law attorney (or FTCLDF) before the chat wedge launches — the trust
// gate in docs/producer-platform-plan.md.
//
// This module is the single source of truth for corpus DATA. Every row is
// re-validated against the zod schema here at module load: an uncitable or
// malformed row fails the build loudly instead of being served. The seed
// script (scripts/seed-regulations-corpus.ts) loads these rows into
// regulation_corpus_rules; the engine only ever reads the DB.

import {
  agencyContactSchema,
  corpusRuleSchema,
  type AgencyContact,
  type CorpusRule,
} from "../schema";
import { coloradoRules } from "./colorado";
import { washingtonRules } from "./washington";
import { wedgeAgencyContacts } from "./agency-contacts";

// The wedge slots. Coverage tests assert every slot has rules and that the
// parser-resolvable channels are all covered (a covered category with a
// missing channel answers "unknown" by design).
export const WEDGE_STATES = ["WA", "CO"] as const;
export const WEDGE_CATEGORIES = ["cottage_food", "raw_milk", "eggs"] as const;
export const WEDGE_CHANNELS = [
  "farmers_market",
  "on_farm",
  "retail",
  "wholesale",
  "online_intrastate",
  "online_interstate",
  "herdshare", // raw_milk only
] as const;

function validateRows<T>(
  label: string,
  rows: T[],
  validate: (row: T) => { success: boolean; error?: { message: string } }
): T[] {
  const invalid: string[] = [];
  for (const row of rows) {
    const result = validate(row);
    if (!result.success) {
      invalid.push(
        `${label} ${JSON.stringify((row as { id?: string }).id ?? row)}: ${result.error?.message}`
      );
    }
  }
  if (invalid.length > 0) {
    throw new Error(`[regulations] invalid corpus data:\n${invalid.join("\n")}`);
  }
  return rows;
}

export const WEDGE_CORPUS: CorpusRule[] = validateRows(
  "rule",
  [...washingtonRules, ...coloradoRules],
  (row) => corpusRuleSchema.safeParse(row)
);

export const WEDGE_AGENCY_CONTACTS: AgencyContact[] = validateRows(
  "contact",
  wedgeAgencyContacts,
  (row) => agencyContactSchema.safeParse(row)
);
