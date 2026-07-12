/** @jest-environment node */

// Drift guard ACROSS the duplicated structured-data (JSON-LD) copies that AI
// search engines and rich results read. The marketing/fee CLAIMS (pricing, the
// "no mandatory fees" clarification) are hardcoded in several independent
// structured-data blocks that are NOT generated from one source:
//
//   - components/structured-data.tsx  — homepage FAQPage JSON-LD (homepageFaqSchema)
//   - pages/index.tsx                 — the VISIBLE homepage <FAQItem> answers
//   - pages/faq/index.tsx             — faqSections (drives BOTH the /faq accordion
//                                       and the /faq FAQPage JSON-LD from one source)
//   - pages/producer-guide/index.tsx  — HowTo step JSON-LD
//
// The homepage has TWO separate copies of the same FAQ — the JSON-LD answer in
// structured-data.tsx and the visible <FAQItem answer="..."> in index.tsx — that
// are maintained by hand, so an edit to one silently drifts from the other and a
// crawler is handed a different answer than a human reads. The existing
// page-content-html-sync test pins page-content.ts against the HTML page SOURCES,
// but it never reads components/structured-data.tsx and never compares the two
// homepage FAQ copies against each other. This test closes that gap.
//
// See memory: machine-readable-tier-surfaces.md.

import { readFileSync } from "fs";
import { join } from "path";
import {
  PRO_MONTHLY_PRICE_CENTS,
  PRO_ANNUAL_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";
import { feeClaim } from "@/utils/geo/fee-claims";

// --- Sources -----------------------------------------------------------------

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

const STRUCTURED_DATA_FILE = "components/structured-data.tsx";
const INDEX_FILE = "pages/index.tsx";
const FAQ_FILE = "pages/faq/index.tsx";
const PRODUCER_GUIDE_FILE = "pages/producer-guide/index.tsx";

// Slice the substring between two markers, throwing a clear error if either
// marker is gone — a structural rename should fail loudly, not silently pass.
function sliceBetween(
  src: string,
  file: string,
  startMarker: string,
  endMarker: string
): string {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `Could not find start marker ${JSON.stringify(startMarker)} in ${file}. ` +
        `The structured-data block was renamed/restructured — update this test.`
    );
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(
      `Could not find end marker ${JSON.stringify(endMarker)} in ${file}. ` +
        `The structured-data block was renamed/restructured — update this test.`
    );
  }
  return src.slice(start, end);
}

const HOMEPAGE_FAQ_FILE = "utils/homepage-faq.ts";

// The scoped structured-data blocks for each surface.
const homepageJsonLdBlock = sliceBetween(
  read(STRUCTURED_DATA_FILE),
  STRUCTURED_DATA_FILE,
  "const homepageFaqSchema",
  "const websiteSchema"
);
const faqBlock = sliceBetween(
  read(FAQ_FILE),
  FAQ_FILE,
  "const faqSections =",
  "// State to manage"
);
const producerGuideHowToBlock = sliceBetween(
  read(PRODUCER_GUIDE_FILE),
  PRODUCER_GUIDE_FILE,
  '"@type": "HowTo"',
  "}),"
);
// The producer-guide page also embeds a SECOND, standalone FAQPage JSON-LD block
// (after the HowTo block) whose Q/A duplicate facts from /faq + the homepage FAQ.
const producerGuideFaqBlock = sliceBetween(
  read(PRODUCER_GUIDE_FILE),
  PRODUCER_GUIDE_FILE,
  '"@type": "FAQPage"',
  "}),"
);
// The visible homepage FAQ source. Pages/index.tsx renders the FAQ from the
// shared HOMEPAGE_FAQ constant (imported from utils/homepage-faq.ts) so the
// claim text lives there, not inline in the index file.
const indexSource = read(INDEX_FILE);
// The shared FAQ data source – both structured-data.tsx (JSON-LD schema) and
// pages/index.tsx (visible accordion) now derive from this one file to prevent
// drift between the two surfaces. Claim checks must include this source.
const homepageFaqSource = read(HOMEPAGE_FAQ_FILE);

// --- Q/A extraction ----------------------------------------------------------

interface QA {
  question: string;
  answer: string;
}

// FAQPage JSON-LD entries: name + acceptedAnswer.text. Answers/questions here
// contain no embedded double quotes, so a simple [^"]* capture is safe.
function extractJsonLdFaq(block: string): QA[] {
  const re =
    /name:\s*"([^"]*)"\s*,\s*acceptedAnswer:\s*\{\s*"@type":\s*"Answer",\s*text:\s*"([^"]*)"/g;
  const out: QA[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({ question: m[1], answer: m[2] });
  }
  return out;
}

// Extract Q/A pairs from the shared HOMEPAGE_FAQ array in utils/homepage-faq.ts.
// The array uses `question:` / `answer:` keys; values are single- or
// double-quoted strings (possibly multiline via template literals, but in
// practice they're single-line strings so a simple [^"']+ capture is fine).
function extractSharedFaqArray(src: string): QA[] {
  // Match each { question: "...", answer: "..." } object in the exported array.
  const re = /question:\s*"([^"]*)"\s*,\s*answer:\s*"([^"]*)"/g;
  const out: QA[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ question: m[1], answer: m[2] });
  }
  return out;
}

// The homepage FAQ Q/A pairs come from the shared source file. Both the
// JSON-LD schema and the visible accordion derive from the same array so
// there is exactly one copy — no drift possible between the two surfaces.
const homepageJsonLdFaq = extractSharedFaqArray(homepageFaqSource);
const homepageVisibleFaq = homepageJsonLdFaq; // same source, by construction
const producerGuideFaq = extractJsonLdFaq(producerGuideFaqBlock);

// --- Part A: homepage FAQ unified into a single source of truth --------------
//
// Previously the homepage had TWO separate copies (structured-data.tsx JSON-LD
// + pages/index.tsx visible FAQItem inline props) that drifted silently. They
// were unified into utils/homepage-faq.ts; both consumers import from it.
// This section verifies the unification is structural (not accidental).

describe("homepage FAQ: JSON-LD copy vs visible <FAQItem> copy", () => {
  it("extracts a non-empty FAQ from the shared HOMEPAGE_FAQ source", () => {
    expect(homepageJsonLdFaq.length).toBeGreaterThan(0);
    expect(homepageVisibleFaq.length).toBeGreaterThan(0);
  });

  it("structured-data.tsx imports from utils/homepage-faq.ts (not hardcoded)", () => {
    const src = read(STRUCTURED_DATA_FILE);
    expect(src).toMatch(/homepage-faq/);
    expect(src).toMatch(/HOMEPAGE_FAQ/);
  });

  it("pages/index.tsx imports from utils/homepage-faq.ts (not hardcoded)", () => {
    expect(indexSource).toMatch(/homepage-faq/);
    expect(indexSource).toMatch(/HOMEPAGE_FAQ/);
  });

  it("covers the same set of questions in both copies", () => {
    const jsonLdQs = homepageJsonLdFaq.map((q) => q.question).sort();
    const visibleQs = homepageVisibleFaq.map((q) => q.question).sort();
    expect(jsonLdQs).toEqual(visibleQs);
  });

  const visibleByQuestion = new Map(
    homepageVisibleFaq.map((qa) => [qa.question, qa.answer])
  );

  it.each(homepageJsonLdFaq.map((qa) => [qa.question, qa.answer]))(
    'answer for "%s" is non-empty in the shared FAQ source',
    (question, jsonLdAnswer) => {
      const visibleAnswer = visibleByQuestion.get(question);
      expect(visibleAnswer).toBe(jsonLdAnswer);
      expect((jsonLdAnswer as string).length).toBeGreaterThan(0);
    }
  );
});

// --- Sanity: the producer-guide FAQPage block is found and parses ------------

describe("producer-guide FAQPage JSON-LD block", () => {
  it("extracts a non-empty Q/A set (block markers still valid)", () => {
    expect(producerGuideFaq.length).toBeGreaterThan(0);
    for (const { question, answer } of producerGuideFaq) {
      expect(question.length).toBeGreaterThan(0);
      expect(answer.length).toBeGreaterThan(0);
    }
  });
});

// --- Part B: pricing/fee CLAIMS pinned across every structured-data copy ------

const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const HERD_MONTHLY = fmtUsd(PRO_MONTHLY_PRICE_CENTS); // "$21"
const HERD_ANNUAL = fmtUsd(PRO_ANNUAL_PRICE_CENTS); // "$168"
const WRANGLER_LIFETIME = fmtUsd(WRANGLER_LIFETIME_PRICE_CENTS); // "$2,100"

const lit = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const HOMEPAGE_JSONLD =
  "homepage JSON-LD (components/structured-data.tsx homepageFaqSchema)";
const HOMEPAGE_VISIBLE = "homepage visible <FAQItem> (pages/index.tsx)";
const FAQ_SURFACE =
  "/faq JSON-LD + accordion (pages/faq/index.tsx faqSections)";
const PRODUCER_GUIDE_HOWTO_SURFACE =
  "producer-guide HowTo JSON-LD (pages/producer-guide/index.tsx)";
const PRODUCER_GUIDE_FAQ_SURFACE =
  "producer-guide FAQPage JSON-LD (pages/producer-guide/index.tsx)";

// Named structured-data surfaces, scoped to the JSON-LD / rich-result block.
// The homepage FAQ claim text now lives in utils/homepage-faq.ts (single
// source of truth for both the JSON-LD schema and the visible accordion),
// so both homepage surfaces include homepageFaqSource for claim matching.
// HOMEPAGE_VISIBLE also includes the full index source because some claims
// (e.g. "No platform fees.") appear in page-level marketing copy, not the FAQ.
const SURFACES: Record<string, string> = {
  [HOMEPAGE_JSONLD]: homepageFaqSource,
  [HOMEPAGE_VISIBLE]: indexSource + "\n" + homepageFaqSource,
  [FAQ_SURFACE]: faqBlock,
  [PRODUCER_GUIDE_HOWTO_SURFACE]: producerGuideHowToBlock,
  [PRODUCER_GUIDE_FAQ_SURFACE]: producerGuideFaqBlock,
};

interface Claim {
  id: string;
  label: string;
  pattern: RegExp;
  // Which named SURFACES must contain the claim.
  surfaces: string[];
}

// The fee/pricing-bearing copies. The producer-guide FAQPage block carries no
// pricing/fee text (those facts live in its HowTo block), so it is NOT here.
const FEE_SURFACES = [
  HOMEPAGE_JSONLD,
  HOMEPAGE_VISIBLE,
  FAQ_SURFACE,
  PRODUCER_GUIDE_HOWTO_SURFACE,
];
// The producer-guide HowTo step only names the Herd monthly price; the annual
// and Wrangler lifetime prices live in the other three structured-data copies.
const PRICE_SURFACES = [HOMEPAGE_JSONLD, HOMEPAGE_VISIBLE, FAQ_SURFACE];
// The "zero/no platform fees" phrasing only appears in the visible homepage copy
// ("No platform fees.") and the producer-guide HowTo step ("no platform fees").
// The homepage FAQ JSON-LD and the /faq copy use the "no mandatory transaction
// fees" wording instead and legitimately omit "platform fees", so they are NOT
// here (pinning them would be a false failure).
const PLATFORM_FEE_SURFACES = [HOMEPAGE_VISIBLE, PRODUCER_GUIDE_HOWTO_SURFACE];
// The producer-guide FAQPage block restates payment/tax/privacy facts that also
// appear in the /faq accordion+JSON-LD; pin them so a reword on one drifts loudly.
const PG_FAQ_AND_FAQ = [PRODUCER_GUIDE_FAQ_SURFACE, FAQ_SURFACE];

// The fee CLAIM wording comes from the single source of truth in
// utils/geo/fee-claims.ts (shared with the absence guard in
// discovery-files-no-claims.test.ts), so a reword flows through both tests.
const NO_MANDATORY_FEES = feeClaim("no-mandatory-fees");
const PLATFORM_FEE = feeClaim("platform-fee");
const NEVER_ADDS_A_FEE = feeClaim("never-adds-a-fee");
const NO_FEES_AT_ALL = feeClaim("no-fees-at-all");

const CLAIMS: Claim[] = [
  {
    id: NO_MANDATORY_FEES.id,
    label: NO_MANDATORY_FEES.label,
    pattern: NO_MANDATORY_FEES.pattern,
    surfaces: FEE_SURFACES,
  },
  {
    id: PLATFORM_FEE.id,
    label: PLATFORM_FEE.label,
    pattern: PLATFORM_FEE.pattern,
    surfaces: PLATFORM_FEE_SURFACES,
  },
  {
    id: NEVER_ADDS_A_FEE.id,
    label: NEVER_ADDS_A_FEE.label,
    pattern: NEVER_ADDS_A_FEE.pattern,
    surfaces: FEE_SURFACES,
  },
  {
    id: NO_FEES_AT_ALL.id,
    label: NO_FEES_AT_ALL.label,
    pattern: NO_FEES_AT_ALL.pattern,
    surfaces: FEE_SURFACES,
  },
  {
    id: "herd-monthly-price",
    label: `Herd monthly price (${HERD_MONTHLY}/month)`,
    pattern: lit(HERD_MONTHLY),
    surfaces: FEE_SURFACES,
  },
  {
    id: "herd-annual-price",
    label: `Herd annual price (${HERD_ANNUAL}/year)`,
    pattern: lit(HERD_ANNUAL),
    surfaces: PRICE_SURFACES,
  },
  {
    id: "wrangler-lifetime-price",
    label: `Wrangler lifetime price (one-time ${WRANGLER_LIFETIME})`,
    pattern: lit(WRANGLER_LIFETIME),
    surfaces: PRICE_SURFACES,
  },
  // --- producer-guide FAQPage <-> /faq shared payment/tax/privacy claims ------
  {
    id: "pay-lightning",
    label: "payment method: Bitcoin Lightning",
    pattern: /Lightning/,
    surfaces: PG_FAQ_AND_FAQ,
  },
  {
    id: "pay-cashu",
    label: "payment method: Cashu",
    pattern: /Cashu/,
    surfaces: PG_FAQ_AND_FAQ,
  },
  {
    id: "pay-stripe",
    label: "payment method: Stripe cards",
    pattern: /Stripe/,
    surfaces: PG_FAQ_AND_FAQ,
  },
  {
    id: "pay-manual-fiat",
    label: "payment method: manual fiat (Cash App/Venmo/PayPal)",
    pattern: /Cash App|Venmo|PayPal/i,
    surfaces: PG_FAQ_AND_FAQ,
  },
  {
    id: "sales-tax-stripe-card",
    label: "sales tax claim (Stripe-calculated, card orders only)",
    pattern: /sales tax/i,
    surfaces: PG_FAQ_AND_FAQ,
  },
  {
    id: "messages-encrypted",
    label: "privacy claim (messages/data encrypted)",
    pattern: /encrypted/i,
    surfaces: [
      PRODUCER_GUIDE_FAQ_SURFACE,
      FAQ_SURFACE,
      HOMEPAGE_JSONLD,
      HOMEPAGE_VISIBLE,
    ],
  },
];

type Check = { claim: Claim; surface: string };
const checks: Check[] = [];
for (const claim of CLAIMS) {
  for (const surface of claim.surfaces) {
    checks.push({ claim, surface });
  }
}

describe("structured-data pricing/fee claims stay in sync across copies", () => {
  it.each(checks)(
    "$claim.label is present in $surface",
    ({ claim, surface }) => {
      const present = claim.pattern.test(SURFACES[surface]);
      if (!present) {
        throw new Error(
          `DRIFT: claim "${claim.label}" (${claim.id}) is missing from ${surface}. ` +
            `Expected to match ${claim.pattern}. One structured-data copy was edited ` +
            `without the others — update that surface so every JSON-LD/rich-result ` +
            `copy agrees (see machine-readable-tier-surfaces.md).`
        );
      }
      expect(present).toBe(true);
    }
  );

  it("derives canonical prices from utils/pro/constants.ts", () => {
    expect(HERD_MONTHLY).toBe("$21");
    expect(HERD_ANNUAL).toBe("$168");
    expect(WRANGLER_LIFETIME).toBe("$2,100");
  });
});
