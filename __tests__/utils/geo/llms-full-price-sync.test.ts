/** @jest-environment node */

// Drift guard between the LLM-facing copy served to AI agents at
// `public/llms-full.txt` and the canonical membership pricing / fee claims that
// live in `utils/pro/constants.ts`.
//
// The same Herd/Wrangler prices and "no platform fee" / payment-method claims
// are duplicated here AND in `utils/geo/page-content.ts` and the human-facing
// HTML pages (covered by page-content-html-sync.test.ts). `llms-full.txt` is a
// static file served verbatim to LLMs, so a price change (e.g. Herd $21,
// Wrangler $2,100) could update every other surface while this file silently
// goes stale — handing agents confidently wrong numbers. (See memory:
// machine-readable-tier-surfaces.md — llms-full.txt must stay in lockstep with
// utils/pro/constants.ts.)
//
// This test pins a small, explicit set of "must-stay-in-sync" CLAIMS. Each
// claim is a canonical value that MUST appear in llms-full.txt. If the file's
// copy drifts (a price bumps, a method is dropped), the canonical value
// disappears and the matching check fails, naming the exact claim that drifted.
//
// To extend: add a row to CLAIMS. Membership prices are derived from
// utils/pro/constants.ts so a constant change also forces this file to update.

import { readFileSync } from "fs";
import { join } from "path";
import {
  PRO_MONTHLY_PRICE_CENTS,
  PRO_ANNUAL_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";

// --- Surface -----------------------------------------------------------------

const llmsFull = readFileSync(
  join(process.cwd(), "public/llms-full.txt"),
  "utf8"
);

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
  // The canonical value that must be present in llms-full.txt.
  pattern: RegExp;
}

const CLAIMS: Claim[] = [
  {
    id: "herd-monthly-price",
    label: `Herd monthly price (${HERD_MONTHLY}/month)`,
    pattern: lit(`${HERD_MONTHLY}/month`),
  },
  {
    id: "herd-annual-price",
    label: `Herd annual price (${HERD_ANNUAL}/year)`,
    pattern: lit(`${HERD_ANNUAL}/year`),
  },
  {
    id: "wrangler-lifetime-price",
    label: `Wrangler lifetime price (one-time ${WRANGLER_LIFETIME})`,
    pattern: lit(WRANGLER_LIFETIME),
  },
  {
    id: "no-platform-fee",
    label: 'fee claim ("no platform fee")',
    pattern: /no platform fee/i,
  },
  {
    id: "pay-lightning",
    label: "payment method: Bitcoin Lightning",
    pattern: /Lightning/,
  },
  {
    id: "pay-cashu",
    label: "payment method: Cashu ecash",
    pattern: /Cashu/,
  },
  {
    id: "pay-stripe",
    label: "payment method: Stripe cards",
    pattern: /Stripe/,
  },
  {
    id: "pay-manual-fiat",
    label: "payment method: manual fiat (Venmo/Cash App/Zelle/PayPal/cash)",
    pattern: /manual fiat|Venmo|Cash App|Zelle|PayPal|\bcash\b/i,
  },
];

// --- Tests -------------------------------------------------------------------

describe("public/llms-full.txt ↔ utils/pro/constants.ts claim sync", () => {
  it.each(CLAIMS)("$label is present in public/llms-full.txt", (claim) => {
    const present = claim.pattern.test(llmsFull);
    if (!present) {
      throw new Error(
        `DRIFT: claim "${claim.label}" (${claim.id}) is missing from ` +
          `public/llms-full.txt. Expected to match ${claim.pattern}. Update ` +
          `that file so the LLM copy agrees with utils/pro/constants.ts (see ` +
          `machine-readable-tier-surfaces.md).`
      );
    }
    expect(present).toBe(true);
  });

  // Sanity: the canonical prices wired into CLAIMS actually came from constants,
  // so a price change in utils/pro/constants.ts forces this file to follow.
  it("derives canonical prices from utils/pro/constants.ts", () => {
    expect(HERD_MONTHLY).toBe("$21");
    expect(HERD_ANNUAL).toBe("$168");
    expect(WRANGLER_LIFETIME).toBe("$2,100");
  });
});
