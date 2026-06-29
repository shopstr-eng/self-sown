/** @jest-environment node */

// Companion to discovery-files-no-pricing.test.ts.
//
// Per memory machine-readable-tier-surfaces.md, the rich-content surfaces
// (`public/llms-full.txt`, `utils/geo/page-content.ts`) and the duplicated
// JSON-LD blocks (homepage / /faq / /producer-guide) carry the marketing/FAQ
// fee CLAIMS — the "no mandatory fees" / "zero platform fees" / fee-structure
// wording. The "pure discovery/transport" files served to AI agents describe
// MCP transport, scopes, rate limits, A2A skills, feeds, and shop products;
// fee/marketing claims are NOT applicable there.
//
// The pricing-absence test pins that membership *prices* never leak into those
// discovery files. But a pasted fee CLAIM (e.g. "no platform fee") would drift
// exactly the same way a pasted price would: it would live independently of the
// canonical fee copy and silently go stale, handing agents an outdated
// marketing claim. This test asserts the canonical fee/marketing claim strings
// are ABSENT from every pure-discovery surface, naming the file that picked one
// up. It mirrors the structure of discovery-files-no-pricing.test.ts.

import { readFileSync } from "fs";
import { join } from "path";
import { FEE_CLAIMS } from "@/utils/geo/fee-claims";

// --- Pure-discovery surfaces (must NOT carry fee/marketing claims) -----------
//
// Same list as discovery-files-no-pricing.test.ts, mirroring the "Pure
// discovery/transport — do NOT add pricing" bullet in
// machine-readable-tier-surfaces.md.

const DISCOVERY_FILES = [
  "public/llms.txt",
  "public/agents.txt",
  "public/skill.md",
  "public/.well-known/mcp.json",
  "public/.well-known/agent-card.json",
  "public/.well-known/l402.json",
  "pages/api/openapi.json.ts",
  "pages/api/.well-known/agent.json.ts",
  "utils/geo/stall-content.ts",
];

// --- Canonical fee/marketing claim patterns ----------------------------------
//
// These are the fee-structure CLAIMS that live in the rich-content surfaces and
// the JSON-LD copies. They come from the single source of truth in
// `utils/geo/fee-claims.ts` (shared with the presence guard in
// structured-data-claim-sync.test.ts), so a reword of the canonical claim flows
// through both tests automatically and can never drift here. They are written
// tightly enough that legitimate discovery content — "free shipping", a "free
// to use" API, "no platform gatekeeping" — does NOT match.

// --- Tests -------------------------------------------------------------------

describe("pure-discovery surfaces stay free of fee/marketing claims", () => {
  const cases = DISCOVERY_FILES.flatMap((file) =>
    FEE_CLAIMS.map((claim) => ({ file, claim }))
  );

  it.each(cases)(
    "$file does not contain the $claim.label",
    ({ file, claim }) => {
      const contents = readFileSync(join(process.cwd(), file), "utf8");
      const match = claim.pattern.exec(contents);
      if (match) {
        throw new Error(
          `DRIFT: discovery file "${file}" contains the ${claim.label} ` +
            `(${claim.id}): matched ${JSON.stringify(match[0])}. Fee/marketing ` +
            `claims must live only in the rich-content surfaces ` +
            `(public/llms-full.txt and utils/geo/page-content.ts) and the ` +
            `JSON-LD blocks (homepage / /faq / /producer-guide). Remove the ` +
            `claim from "${file}" — pure discovery/transport files must not ` +
            `carry fee/marketing claims (see machine-readable-tier-surfaces.md).`
        );
      }
      expect(match).toBeNull();
    }
  );
});
