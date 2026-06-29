/** @jest-environment node */

// Presence guard for the canonical fee CLAIMS in the RICH-CONTENT surfaces that
// AI/LLM agents read directly: `public/llms-full.txt` and
// `utils/geo/page-content.ts`.
//
// Companion to the two existing guards keyed off the same single source of truth
// (`utils/geo/fee-claims.ts`):
//
//   - structured-data-claim-sync.test.ts — pins the canonical fee claims PRESENT
//     across the JSON-LD / rich-result copies (homepage / /faq / producer-guide).
//   - discovery-files-no-claims.test.ts  — pins the canonical fee claims ABSENT
//     from every pure-discovery/transport surface.
//
// Neither of those reads the rich-content files, yet those files carry the SAME
// fee promises ("no platform fee", "no fees at all", "Zero Platform Fees",
// "no mandatory platform fees") in the copy agents consume. If someone deletes
// or rewords a fee promise there, no test fails today and an agent could be
// handed an inconsistent or missing fee claim. This test closes that gap.
//
// Each claim is mapped ONLY to the surface that genuinely carries its phrasing,
// to avoid false failures:
//   - public/llms-full.txt   carries "no platform fee" + "no fees at all".
//   - utils/geo/page-content.ts carries "no mandatory platform fees" + the
//     "Zero Platform Fees" title (both match the platform-fee pattern).
// Neither rich-content file uses the "never adds a fee" wording, so that claim
// is intentionally unmapped here (pinning it would be a false failure).
//
// See memory: machine-readable-tier-surfaces.md.

import { readFileSync } from "fs";
import { join } from "path";
import { feeClaim } from "@/utils/geo/fee-claims";

// --- Rich-content surfaces ---------------------------------------------------

const LLMS_FULL_FILE = "public/llms-full.txt";
const PAGE_CONTENT_FILE = "utils/geo/page-content.ts";

const SURFACES: Record<string, string> = {
  [LLMS_FULL_FILE]: readFileSync(join(process.cwd(), LLMS_FULL_FILE), "utf8"),
  [PAGE_CONTENT_FILE]: readFileSync(
    join(process.cwd(), PAGE_CONTENT_FILE),
    "utf8"
  ),
};

// --- Canonical fee claims, mapped to the surface that carries each phrasing ---
//
// The CLAIM wording comes from the single source of truth in
// utils/geo/fee-claims.ts (shared with both the presence guard for the JSON-LD
// copies and the absence guard for discovery files), so a reword flows through
// every test automatically — no new hardcoded regexes here.

interface Check {
  surface: string;
  id: string;
  label: string;
  pattern: RegExp;
}

const MAPPING: Record<string, string[]> = {
  // llms-full.txt: "charges no platform fee on sales" + "have no fees at all".
  [LLMS_FULL_FILE]: ["platform-fee", "no-fees-at-all"],
  // page-content.ts: "Zero Platform Fees" title + "no mandatory platform fees".
  [PAGE_CONTENT_FILE]: ["platform-fee", "no-mandatory-fees"],
};

const checks: Check[] = Object.entries(MAPPING).flatMap(([surface, ids]) =>
  ids.map((id) => {
    const claim = feeClaim(id);
    return {
      surface,
      id: claim.id,
      label: claim.label,
      pattern: claim.pattern,
    };
  })
);

describe("rich-content surfaces keep their canonical fee claims", () => {
  it.each(checks)(
    "$label is present in $surface",
    ({ surface, id, label, pattern }) => {
      const present = pattern.test(SURFACES[surface]);
      if (!present) {
        throw new Error(
          `DRIFT: claim "${label}" (${id}) is missing from ${surface}. ` +
            `Expected to match ${pattern}. A fee promise that AI/LLM agents read ` +
            `directly was deleted or reworded — restore the canonical wording so ` +
            `agents are never handed an inconsistent or missing fee claim ` +
            `(see machine-readable-tier-surfaces.md).`
        );
      }
      expect(present).toBe(true);
    }
  );
});
