/** @jest-environment node */

// Inverse drift guard to llms-full-price-sync.test.ts.
//
// Membership pricing belongs ONLY in the rich-content surfaces that enumerate
// tiers (`public/llms-full.txt` and `utils/geo/page-content.ts`), kept in
// lockstep with `utils/pro/constants.ts`. The "pure discovery/transport"
// files served to AI agents describe MCP transport, scopes, rate limits, A2A
// skills, and shop products — membership tiers are NOT applicable there.
// (See memory: machine-readable-tier-surfaces.md.)
//
// Nothing stops someone from accidentally pasting a price like "$21" or
// "$2,100" into one of those discovery files, where it would drift
// independently of utils/pro/constants.ts and silently go stale, handing
// agents wrong numbers. This test asserts the canonical price strings are
// ABSENT from every pure-discovery surface, naming the file that picked one up.
//
// The canonical price strings are derived from utils/pro/constants.ts using the
// same fmtUsd helper as llms-full-price-sync.test.ts, so they always reflect
// the real prices.

import { readFileSync } from "fs";
import { join } from "path";
import {
  PRO_MONTHLY_PRICE_CENTS,
  PRO_ANNUAL_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";

// --- Pure-discovery surfaces (must NOT carry membership pricing) --------------
//
// This list mirrors the "Pure discovery/transport — do NOT add pricing" bullet
// in machine-readable-tier-surfaces.md.

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

// --- Canonical price strings (derived from constants, single source of truth) -

const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const HERD_MONTHLY = fmtUsd(PRO_MONTHLY_PRICE_CENTS); // "$21"
const HERD_ANNUAL = fmtUsd(PRO_ANNUAL_PRICE_CENTS); // "$168"
const WRANGLER_LIFETIME = fmtUsd(WRANGLER_LIFETIME_PRICE_CENTS); // "$2,100"

// Match the canonical price exactly: anchored on "$" and not part of a larger
// number (so an example product price like "$210" or "$8" can't false-positive
// on the "$21" membership price).
const priceRegex = (price: string) =>
  new RegExp(`${price.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.,])`);

interface CanonicalPrice {
  id: string;
  label: string;
  value: string;
}

const CANONICAL_PRICES: CanonicalPrice[] = [
  {
    id: "herd-monthly-price",
    label: `Herd monthly price (${HERD_MONTHLY})`,
    value: HERD_MONTHLY,
  },
  {
    id: "herd-annual-price",
    label: `Herd annual price (${HERD_ANNUAL})`,
    value: HERD_ANNUAL,
  },
  {
    id: "wrangler-lifetime-price",
    label: `Wrangler lifetime price (${WRANGLER_LIFETIME})`,
    value: WRANGLER_LIFETIME,
  },
];

// --- Tests -------------------------------------------------------------------

describe("pure-discovery surfaces stay free of membership pricing", () => {
  const cases = DISCOVERY_FILES.flatMap((file) =>
    CANONICAL_PRICES.map((price) => ({ file, price }))
  );

  it.each(cases)(
    "$file does not contain the $price.label",
    ({ file, price }) => {
      const contents = readFileSync(join(process.cwd(), file), "utf8");
      const match = priceRegex(price.value).exec(contents);
      if (match) {
        throw new Error(
          `DRIFT: discovery file "${file}" contains the membership price ` +
            `"${price.value}" (${price.id}). Membership pricing must live only ` +
            `in the rich-content surfaces (public/llms-full.txt and ` +
            `utils/geo/page-content.ts), kept in sync with ` +
            `utils/pro/constants.ts. Remove the price from "${file}" — pure ` +
            `discovery/transport files must not carry pricing (see ` +
            `machine-readable-tier-surfaces.md).`
        );
      }
      expect(match).toBeNull();
    }
  );

  // Sanity: the canonical prices wired into the check actually came from
  // constants, so a price change in utils/pro/constants.ts flows through here.
  it("derives canonical prices from utils/pro/constants.ts", () => {
    expect(HERD_MONTHLY).toBe("$21");
    expect(HERD_ANNUAL).toBe("$168");
    expect(WRANGLER_LIFETIME).toBe("$2,100");
  });
});
