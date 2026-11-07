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
    question: "Can I sell raw milk in Texas?",
    expect: {
      status: "unknown",
      messageIncludes: ["I won't guess", "ask the regulator directly"],
    },
    sourceMatrix: "Fail-closed contract — no corpus for TX, agency path instead of a guess",
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
