/** @jest-environment node */

// Drift guard between the two copies of Milk Market's marketing/legal facts:
//
//   1. The machine-readable copy served to AI agents — `utils/geo/page-content.ts`
//      (returned by /api/agent-view on content negotiation).
//   2. The human-facing HTML pages — `pages/index.tsx`, `pages/faq/index.tsx`,
//      `pages/producer-guide/index.tsx`, etc.
//
// These live in SEPARATE sources, so a price change, a renamed membership tier,
// a new/removed payment method, or a reworded fee claim can land on the HTML
// page while the agent copy silently goes stale — handing agents confidently
// wrong facts while every other test stays green. (See memory:
// machine-readable-tier-surfaces.md — tier/FAQ/fee claims are duplicated across
// many surfaces and must move in lockstep.)
//
// This test pins a small, explicit set of "must-stay-in-sync" CLAIMS. Each claim
// is a canonical value that MUST appear in every surface it is declared on. If
// any surface edits its copy (a price bumps, a method is dropped), the canonical
// value disappears there and the matching check fails, naming the exact claim and
// surface that drifted.
//
// To extend: add a row to CLAIMS. Membership prices are derived from
// utils/pro/constants.ts so a constant change also forces every surface to update.

import { readFileSync } from "fs";
import { join } from "path";
import { PAGE_CONTENT } from "@/utils/geo/page-content";
import {
  PRO_MONTHLY_PRICE_CENTS,
  PRO_ANNUAL_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";

// --- Surfaces ----------------------------------------------------------------

// Human-facing HTML pages, keyed by a short name used in CLAIMS below.
const HTML_PAGE_FILES: Record<string, string> = {
  index: "pages/index.tsx",
  about: "pages/about/index.tsx",
  faq: "pages/faq/index.tsx",
  contact: "pages/contact/index.tsx",
  "producer-guide": "pages/producer-guide/index.tsx",
  terms: "pages/terms/index.tsx",
  privacy: "pages/privacy/index.tsx",
};

// Read each HTML page's raw source once. We match against source text (not a
// rendered DOM) because a stale price/fact is wrong wherever it lives in the JSX.
const htmlSource: Record<string, string> = {};
for (const [name, file] of Object.entries(HTML_PAGE_FILES)) {
  htmlSource[name] = readFileSync(join(process.cwd(), file), "utf8");
}

// The agent copy for a given path = title + description + markdown concatenated.
function agentText(path: string): string {
  const entry = PAGE_CONTENT[path];
  if (!entry) {
    throw new Error(`page-content.ts has no entry for "${path}"`);
  }
  return `${entry.title}\n${entry.description}\n${entry.markdown}`;
}

// --- Canonical price strings (derived from constants, single source of truth) -

const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const HERD_MONTHLY = fmtUsd(PRO_MONTHLY_PRICE_CENTS); // "$21"
const HERD_ANNUAL = fmtUsd(PRO_ANNUAL_PRICE_CENTS); // "$168"
const WRANGLER_LIFETIME = fmtUsd(WRANGLER_LIFETIME_PRICE_CENTS); // "$2,100"

// Escape a literal string for use inside a RegExp.
const lit = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

// --- Claims ------------------------------------------------------------------

interface Claim {
  id: string;
  // What the claim asserts, surfaced in the failure message.
  label: string;
  // The canonical value that must be present in every declared surface.
  pattern: RegExp;
  // page-content.ts paths whose entry must contain the claim.
  agentPaths: string[];
  // HTML page keys (HTML_PAGE_FILES) whose source must contain the claim.
  htmlPages: string[];
}

const CLAIMS: Claim[] = [
  {
    id: "herd-monthly-price",
    label: `Herd monthly price (${HERD_MONTHLY}/month)`,
    pattern: lit(HERD_MONTHLY),
    agentPaths: ["/producer-guide"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "herd-annual-price",
    label: `Herd annual price (${HERD_ANNUAL}/year)`,
    pattern: lit(HERD_ANNUAL),
    agentPaths: ["/producer-guide"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "wrangler-lifetime-price",
    label: `Wrangler lifetime price (one-time ${WRANGLER_LIFETIME})`,
    pattern: lit(WRANGLER_LIFETIME),
    agentPaths: ["/producer-guide"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "no-mandatory-fees",
    label: 'fee claim ("no mandatory ... fees")',
    pattern: /no mandatory[\s\S]{0,40}?fees/i,
    agentPaths: ["/"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "pay-lightning",
    label: "payment method: Bitcoin Lightning",
    pattern: /Lightning/,
    agentPaths: ["/", "/faq"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "pay-cashu",
    label: "payment method: Cashu ecash",
    pattern: /Cashu/,
    agentPaths: ["/", "/faq"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "pay-stripe",
    label: "payment method: Stripe cards",
    pattern: /Stripe/,
    agentPaths: ["/", "/faq", "/producer-guide"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "pay-square",
    label: "payment method: Square cards",
    pattern: /Square/,
    agentPaths: ["/", "/faq", "/producer-guide"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
  {
    id: "pay-manual-fiat",
    label: "payment method: manual fiat (Venmo/Cash App/Zelle/PayPal/cash)",
    pattern: /manual fiat|Venmo|Cash App|Zelle|PayPal|\bcash\b/i,
    agentPaths: ["/", "/faq"],
    htmlPages: ["index", "faq", "producer-guide"],
  },
];

// --- Tests -------------------------------------------------------------------

// Flatten claims into one check per (claim, surface) so a failure names exactly
// which page and which claim drifted.
type Check = { claim: Claim; surface: string; text: () => string };

const checks: Check[] = [];
for (const claim of CLAIMS) {
  for (const path of claim.agentPaths) {
    checks.push({
      claim,
      surface: `agent copy page-content.ts["${path}"]`,
      text: () => agentText(path),
    });
  }
  for (const page of claim.htmlPages) {
    checks.push({
      claim,
      surface: `HTML page ${HTML_PAGE_FILES[page]}`,
      text: () => htmlSource[page],
    });
  }
}

describe("page-content.ts ↔ HTML page claim sync", () => {
  it.each(checks)(
    "$claim.label is present in $surface",
    ({ claim, surface, text }) => {
      const present = claim.pattern.test(text());
      if (!present) {
        throw new Error(
          `DRIFT: claim "${claim.label}" (${claim.id}) is missing from ${surface}. ` +
            `Expected to match ${claim.pattern}. Update that surface so the agent ` +
            `copy and the HTML page agree (see machine-readable-tier-surfaces.md).`
        );
      }
      expect(present).toBe(true);
    }
  );

  // Sanity: the canonical prices wired into CLAIMS actually came from constants,
  // so a price change in utils/pro/constants.ts forces every surface to follow.
  it("derives canonical prices from utils/pro/constants.ts", () => {
    expect(HERD_MONTHLY).toBe("$21");
    expect(HERD_ANNUAL).toBe("$168");
    expect(WRANGLER_LIFETIME).toBe("$2,100");
  });
});
