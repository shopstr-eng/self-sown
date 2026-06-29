// Single source of truth for the fee/marketing CLAIM wording that the GEO
// drift guards police. Mirrors how `utils/pro/constants.ts` centralizes the
// membership prices so the pricing tests can't drift.
//
// The fee-structure claims ("no mandatory ... fees", "zero/no platform fees",
// "Milk Market never adds a fee", "no fees at all") are duplicated by hand
// across the rich-content surfaces (`public/llms-full.txt`,
// `utils/geo/page-content.ts`) and the JSON-LD copies (homepage / /faq /
// producer-guide). Two tests guard them in opposite directions:
//
//   - structured-data-claim-sync.test.ts  — pins the canonical claim PRESENT
//     across the structured-data / rich-result copies (so a reword of one copy
//     drifts loudly from the others).
//   - discovery-files-no-claims.test.ts   — pins the canonical claims ABSENT
//     from every pure-discovery/transport surface (so a pasted claim there
//     can't silently go stale).
//
// Both derive their claim patterns from FEE_CLAIMS below, so rewording the
// canonical claim flows through both tests automatically. Edit the wording in
// one place: here.
//
// Patterns intentionally carry no `g` flag, so `.test()` / `.exec()` are
// stateless and a single shared RegExp instance is safe to reuse.

export interface FeeClaim {
  id: string;
  label: string;
  pattern: RegExp;
}

export const FEE_CLAIMS: FeeClaim[] = [
  {
    id: "no-mandatory-fees",
    label: 'fee claim ("no mandatory ... fees")',
    pattern: /no mandatory[\s\S]{0,40}?fees/i,
  },
  {
    id: "platform-fee",
    label: 'platform-fee claim ("zero/no platform fee(s)")',
    pattern: /(?:zero|no)\s+platform\s+fees?/i,
  },
  {
    id: "never-adds-a-fee",
    label: 'fee claim ("never adds a fee")',
    pattern: /never adds a fee/i,
  },
  {
    id: "no-fees-at-all",
    label: 'fee claim ("no fees at all")',
    pattern: /no fees at all/i,
  },
];

const FEE_CLAIMS_BY_ID = new Map(FEE_CLAIMS.map((claim) => [claim.id, claim]));

// Look up a single canonical fee claim by id, failing loudly if an id is
// renamed/removed so a test referencing it breaks instead of silently passing.
export function feeClaim(id: string): FeeClaim {
  const claim = FEE_CLAIMS_BY_ID.get(id);
  if (!claim) {
    throw new Error(
      `Unknown fee claim id ${JSON.stringify(id)}. Known ids: ` +
        `${FEE_CLAIMS.map((c) => c.id).join(", ")}. ` +
        `Update the caller or utils/geo/fee-claims.ts.`
    );
  }
  return claim;
}
