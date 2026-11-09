// The golden Q&A DATA — kept free of runtime imports (types only) so the
// launch gate below can be evaluated by the API route AND the chat page
// without dragging the engine/explainer/model stack into the browser bundle.
// The eval harness and comparator live in ./golden-answers (server/test side).
//
// LAUNCH GATE: the chat stays closed until every case is attorney-approved —
// docs/regulations-attorney-review.md records sign-off; the plan's P0 trust
// gates make this blocking, not advisory.

import type { ConfidenceTier, RuleDecision } from "./schema";

export interface GoldenReview {
  status: "pending_attorney_review" | "approved";
  // Reviewer identity + date are null until sign-off; an "approved" case
  // with no reviewer is invalid (guarded in the eval test).
  reviewer: string | null;
  reviewedAt: string | null;
}

export interface GoldenCase {
  id: string;
  question: string;
  expect: {
    status: "answered" | "clarify" | "unknown";
    decision?: RuleDecision;
    tier?: ConfidenceTier;
    // Substrings that must appear in the served message (drawn from the
    // matrix's conditions/excerpts) and in the citation URLs.
    messageIncludes?: string[];
    citationUrlIncludes?: string[];
  };
  // Which matrix rows this golden answer comes from, so a reviewer can
  // check the expectation against the source data.
  sourceMatrix: string;
  review: GoldenReview;
}

const PENDING: GoldenReview = {
  status: "pending_attorney_review",
  reviewer: null,
  reviewedAt: null,
};

export const GOLDEN_CASES: GoldenCase[] = [
  // ---- Washington × cottage food ----
  {
    id: "wa-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Washington?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["is allowed only under conditions", "$35,000"],
      citationUrlIncludes: ["69.22.050", "69.22.020"],
    },
    sourceMatrix: "WA cottage_food matrix — RCW 69.22 (.050 cap, .020 permit)",
    review: PENDING,
  },
  {
    id: "wa-cottage-food-interstate",
    question: "Can I ship my jam to other states from Washington?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["69.22.020"],
    },
    sourceMatrix: "WA cottage_food matrix — RCW 69.22.020(4) internet/mail-order ban",
    review: PENDING,
  },
  // ---- Washington × raw milk ----
  {
    id: "wa-raw-milk-farmers-market",
    question: "Can I sell raw milk at a farmers market in Washington?",
    expect: {
      status: "answered",
      decision: "conditional",
      messageIncludes: ["is allowed only under conditions", "$250"],
      citationUrlIncludes: ["15.36.051", "16-101-800"],
    },
    sourceMatrix: "WA raw_milk matrix — RCW 15.36.051 license + WAC 16-101-800 label",
    review: PENDING,
  },
  {
    id: "wa-raw-milk-herdshare",
    question: "Can I sell raw milk through a herd share in Washington?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      messageIncludes: ["milk processing plant license"],
      citationUrlIncludes: ["518-RawMilkTruth.pdf"],
    },
    sourceMatrix: "WA raw_milk matrix — WSDA: a share is a sale and needs the license",
    review: PENDING,
  },
  {
    id: "wa-raw-milk-interstate",
    question: "Can I ship raw milk to other states from Washington?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["ecfr.gov"],
    },
    sourceMatrix: "WA raw_milk matrix — 21 CFR 1240.61 federal interstate ban",
    review: PENDING,
  },
  // ---- Washington × eggs ----
  {
    id: "wa-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in Washington?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["$30"],
      citationUrlIncludes: ["69.25.050"],
    },
    sourceMatrix: "WA eggs matrix — RCW 69.25.050 handler/dealer license",
    review: PENDING,
  },
  // ---- Colorado × cottage food ----
  {
    id: "co-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Colorado?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["net revenue"],
      citationUrlIncludes: ["25-4-1614"],
    },
    sourceMatrix: "CO cottage_food matrix — C.R.S. § 25-4-1614 (products, course, cap, label)",
    review: PENDING,
  },
  {
    id: "co-cottage-food-online-intrastate",
    question: "Can I sell jam online within my state in Colorado?",
    expect: {
      status: "answered",
      decision: "conditional",
      messageIncludes: ["Direct producer-to-consumer delivery"],
      citationUrlIncludes: ["25-4-1614"],
    },
    sourceMatrix: "CO cottage_food matrix — § 25-4-1614 in-state direct delivery only",
    review: PENDING,
  },
  {
    id: "co-cottage-food-retail",
    question: "Can I sell my jam in grocery stores in Colorado?",
    expect: {
      status: "answered",
      decision: "prohibited",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["25-4-1614"],
    },
    sourceMatrix: "CO cottage_food matrix — § 25-4-1614 no resale / third-party retail",
    review: PENDING,
  },
  // ---- Colorado × raw milk ----
  {
    id: "co-raw-milk-farmers-market",
    question: "Can I sell raw milk at a farmers market in Colorado?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["25-5-5-117"],
    },
    sourceMatrix: "CO raw_milk matrix — C.R.S. § 25-5.5-117 retail-sales ban",
    review: PENDING,
  },
  {
    id: "co-raw-milk-herdshare",
    question: "Can I sell raw milk through a herd share in Colorado?",
    expect: {
      status: "answered",
      decision: "conditional",
      messageIncludes: ["CDPHE", "bill of sale"],
      citationUrlIncludes: ["25-5-5-117"],
    },
    sourceMatrix: "CO raw_milk matrix — § 25-5.5-117 registered share conditions",
    review: PENDING,
  },
  // ---- Colorado × eggs ----
  {
    id: "co-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in Colorado?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["250 dozen"],
      citationUrlIncludes: ["35-21-105"],
    },
    sourceMatrix: "CO eggs matrix — C.R.S. § 35-21-105 <250 dozen/month exemption",
    review: PENDING,
  },
  // ---- Oregon × cottage food ----
  {
    id: "or-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Oregon?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["is allowed only under conditions", "$50,000"],
      citationUrlIncludes: ["ors616.html"],
    },
    sourceMatrix:
      "OR cottage_food matrix — ORS 616.723 residential-dwelling exemption (cap, products, label)",
    review: PENDING,
  },
  {
    id: "or-cottage-food-interstate",
    question: "Can I ship my jam to other states from Oregon?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      // Oregon does not ban interstate mail-order — the answer must defer to
      // the destination state's law, not declare a prohibition.
      messageIncludes: ["destination state"],
      citationUrlIncludes: ["CottageFoodExemptionFAQ"],
    },
    sourceMatrix:
      "OR cottage_food matrix — ODA FAQ: destination state's law governs interstate shipments",
    review: PENDING,
  },
  // ---- Oregon × raw milk ----
  {
    id: "or-raw-milk-farmers-market",
    question: "Can I sell raw milk at a farmers market in Oregon?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      // Cow milk is banned at retail outright; goat/sheep milk needs ODA
      // licensing off-premises — the answer must carry the cow-milk ban.
      messageIncludes: ["unpasteurized milk or fluid milk from cows"],
      citationUrlIncludes: ["ors621.html"],
    },
    sourceMatrix:
      "OR raw_milk matrix — ORS 621.116 cow-milk retail ban + ORS 621.012 on-farm-only exemption",
    review: PENDING,
  },
  {
    id: "or-raw-milk-interstate",
    question: "Can I ship raw milk to other states from Oregon?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["ecfr.gov"],
    },
    sourceMatrix: "OR raw_milk matrix — 21 CFR 1240.61 federal interstate ban",
    review: PENDING,
  },
  {
    id: "or-raw-milk-herdshare-unknown",
    question: "Can I sell raw milk through a herd share in Oregon?",
    expect: {
      status: "unknown",
      messageIncludes: ["I won't guess"],
    },
    sourceMatrix:
      "Fail-closed contract — no OR herdshare statute was found, so herdshare questions answer unknown by design",
    review: PENDING,
  },
  // ---- Oregon × eggs ----
  {
    id: "or-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in Oregon?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["egg handler"],
      citationUrlIncludes: ["ors632.html"],
    },
    sourceMatrix:
      "OR eggs matrix — ORS 632.715 handler license with producer-direct exemption",
    review: PENDING,
  },
  // ---- Idaho × cottage food (agency-guidance tier, no statute) ----
  {
    id: "id-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Idaho?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      messageIncludes: ["not required by Idaho law", "Cottage Foods Risk Assessment"],
      citationUrlIncludes: ["cdh.idaho.gov"],
    },
    sourceMatrix:
      "ID cottage_food matrix — CDH Cottage Foods FAQ (no permit, no cap, venue may require risk-assessment form)",
    review: PENDING,
  },
  {
    id: "id-cottage-food-retail",
    question: "Can I sell my jam in grocery stores in Idaho?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "agency_guidance",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["cdh.idaho.gov"],
    },
    sourceMatrix:
      "ID cottage_food matrix — CDH FAQ: third-party/wholesale distribution ends the exemption",
    review: PENDING,
  },
  // ---- Idaho × raw milk ----
  {
    id: "id-raw-milk-herdshare",
    question: "Can I sell raw milk through a herd share in Idaho?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["shall not constitute the sale"],
      citationUrlIncludes: ["37-1101"],
    },
    sourceMatrix:
      "ID raw_milk matrix — I.C. § 37-1101 registered share acquisition is not a sale",
    review: PENDING,
  },
  {
    id: "id-raw-milk-interstate",
    question: "Can I ship raw milk to other states from Idaho?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["ecfr.gov"],
    },
    sourceMatrix:
      "ID raw_milk matrix — 21 CFR 1240.61 federal ban + IDAPA 02.04.13 in-state-only limit",
    review: PENDING,
  },
  // ---- Idaho × eggs ----
  {
    id: "id-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in Idaho?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      messageIncludes: ["UNGRADED EGGS"],
      citationUrlIncludes: ["agri.idaho.gov"],
    },
    sourceMatrix:
      "ID eggs matrix — ISDA <300-bird small-flock exemption with UNGRADED EGGS labeling",
    review: PENDING,
  },
  // ---- California × cottage food ----
  {
    id: "ca-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in California?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["$86,206", "Made in a Home Kitchen"],
      citationUrlIncludes: ["114365"],
    },
    sourceMatrix:
      "CA cottage_food matrix — HSC 114365 Class A registration + 2025 CPI cap + 114365.2 labeling",
    review: PENDING,
  },
  {
    id: "ca-cottage-food-interstate",
    question: "Can I ship my jam to other states from California?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["113758"],
    },
    sourceMatrix:
      "CA cottage_food matrix — HSC 113758 'direct sale' is a within-state transaction",
    review: PENDING,
  },
  // ---- California × raw milk ----
  {
    id: "ca-raw-milk-farmers-market",
    question: "Can I sell raw milk at a farmers market in California?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      messageIncludes: ["market milk permit"],
      citationUrlIncludes: ["cdfa.ca.gov"],
    },
    sourceMatrix:
      "CA raw_milk matrix — CDFA: retail-legal with an FAC § 33222 market milk permit",
    review: PENDING,
  },
  // ---- California × eggs ----
  {
    id: "ca-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in California?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      messageIncludes: ["no exemptions"],
      citationUrlIncludes: ["esqm"],
    },
    sourceMatrix:
      "CA eggs matrix — CDFA ESQM registration is universal; no small-flock exemption",
    review: PENDING,
  },
  // ---- Texas × cottage food (SB 541, eff. 2025-09-01) ----
  {
    id: "tx-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Texas?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["$150,000"],
      citationUrlIncludes: ["HS.437"],
    },
    sourceMatrix:
      "TX cottage_food matrix — HSC ch. 437 as amended by SB 541 (no permit, $150k cap, labeling)",
    review: PENDING,
  },
  {
    id: "tx-cottage-food-interstate",
    question: "Can I ship my jam to other states from Texas?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["HS.437"],
    },
    sourceMatrix:
      "TX cottage_food matrix — HSC 437.0194(c) in-state-only sales limitation",
    review: PENDING,
  },
  // ---- Texas × raw milk ----
  {
    id: "tx-raw-milk-farmers-market",
    question: "Can I sell raw milk at a farmers market in Texas?",
    expect: {
      status: "answered",
      decision: "prohibited",
      tier: "statute_verified",
      messageIncludes: ["is prohibited"],
      citationUrlIncludes: ["217-31"],
    },
    sourceMatrix:
      "TX raw_milk matrix — 25 TAC 217.31 authorizes only on-farm sales and direct delivery",
    review: PENDING,
  },
  // ---- Texas × eggs ----
  {
    id: "tx-eggs-farmers-market",
    question: "Can I sell eggs at a farmers market in Texas?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "statute_verified",
      messageIncludes: ["own flock"],
      citationUrlIncludes: ["AG.132"],
    },
    sourceMatrix:
      "TX eggs matrix — Ag. Code § 132.002 own-flock ungraded exemption",
    review: PENDING,
  },
  // ---- Wisconsin × cottage food (product-scoped exemptions) ----
  {
    id: "wi-cottage-food-farmers-market",
    question: "Can I sell jam at a farmers market in Wisconsin?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      // The answer must present BOTH product paths with their own conditions
      // — never merge the pickle-bill cap/sign onto baked goods or vice versa.
      messageIncludes: ["$5,000", "baked goods"],
      citationUrlIncludes: ["97/ii/29"],
    },
    sourceMatrix:
      "WI cottage_food matrix — § 97.29(2)(b)2 pickle bill + DATCP home-bakers ruling, one product-scoped row per channel",
    review: PENDING,
  },
  {
    id: "wi-cottage-food-interstate",
    question: "Can I ship my homemade cookies to other states from Wisconsin?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      // No exemption squarely covers interstate: the answer must route to
      // DATCP for baked goods, not declare a flat prohibition.
      messageIncludes: ["DATCP"],
      citationUrlIncludes: ["datcp.wi.gov"],
    },
    sourceMatrix:
      "WI cottage_food matrix — interstate uncovered by either exemption; agency contact path, not a blanket prohibition",
    review: PENDING,
  },
  // ---- Ohio × cottage food (retail carries the full requirement set) ----
  {
    id: "oh-cottage-food-retail",
    question: "Can I sell my jam in grocery stores in Ohio?",
    expect: {
      status: "answered",
      decision: "conditional",
      tier: "agency_guidance",
      // The grocery-store channel must carry the statutory label and the
      // approved product list, same as a farmers-market table.
      messageIncludes: ["This product is home produced."],
      citationUrlIncludes: ["3715.023"],
    },
    sourceMatrix:
      "OH cottage_food matrix — ODA retail allowance + ORC 3715.023 label + OAC 901:3-20-04 product list",
    review: PENDING,
  },
  // ---- Fail-closed paths ----
  {
    id: "clarify-channel-when-channels-disagree",
    question: "Can I sell jam in Colorado?",
    expect: {
      status: "clarify",
      messageIncludes: ["how you'd be selling"],
    },
    sourceMatrix: "Engine contract — channels disagree, so it must ask, not aggregate",
    review: PENDING,
  },
  {
    id: "unknown-uncovered-state",
    question: "Can I sell raw milk in Florida?",
    expect: {
      status: "unknown",
      messageIncludes: ["I won't guess", "ask the regulator directly"],
    },
    sourceMatrix: "Fail-closed contract — no corpus for FL, agency path instead of a guess",
    review: PENDING,
  },
  {
    id: "unknown-uncovered-category",
    question: "Can I sell meat at a farmers market in Washington?",
    expect: {
      status: "unknown",
      messageIncludes: ["I won't guess"],
    },
    sourceMatrix: "Fail-closed contract — meat is not in the wedge corpus",
    review: PENDING,
  },
];

// Advisory phrasing that must never appear in a served answer, whether it
// came from the deterministic template or the model: the corpus states what
// the statute says, it never tells the seller what to do. Shared by the
// golden eval and the explain seam's output validator.
export const ADVISORY_PHRASING =
  /\byou should\b|\byou must\b|\byou need to\b|\bwe recommend\b|\bi recommend\b|\bmake sure you\b/i;

/**
 * The launch gate (docs/producer-platform-plan.md, P0 trust gates): the
 * regulation chat serves answers only once every golden case has documented
 * attorney/FTCLDF/extension sign-off. There is deliberately no env override —
 * a flag someone can set in a dashboard would be a gate that isn't one.
 * Approving a case requires editing its review block with the reviewer's
 * name and date, which is exactly the friction the gate exists to create.
 */
export function allGoldenCasesApproved(cases: GoldenCase[]): boolean {
  return (
    cases.length > 0 &&
    cases.every(
      (entry) =>
        entry.review.status === "approved" &&
        !!entry.review.reviewer &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.review.reviewedAt ?? "")
    )
  );
}

export function regulationsChatLaunched(): boolean {
  return allGoldenCasesApproved(GOLDEN_CASES);
}
