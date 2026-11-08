// Wedge corpus — PENNSYLVANIA (PA). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (PA Department of
// Agriculture application packets and guidance on pa.gov, 7 Pa. Code chapter
// 59a on pacodeandbulletin.gov, eCFR) and last verified by re-reading the
// source on 2026-11-08. Excerpts are verbatim from the cited text.
// Pennsylvania cottage food has no standalone statute — home food processing
// is handled by PDA's "limited food establishment" registration framework —
// so those rows are tier agency_guidance (same posture as Idaho). Effective
// dates are null pending session-law verification; the attorney reviewer must
// confirm every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "PA";
const VERIFIED = "2026-11-08";

const PA_LIMITED_FOOD =
  "https://www.pa.gov/content/dam/copapwp-pagov/en/pda/documents/consumer_protection/foodsafety/documents/limited%20food%20establishment%20application%20packet%20_%20rev.%2010.24.pdf";
const PA_RAW_MILK =
  "https://www.pacodeandbulletin.gov/Display/pacode?d&file=%2Fsecure%2Fpacode%2Fdata%2F007%2Fchapter59a%2Fs59a.402.html";
const PA_EGGS =
  "https://www.pa.gov/content/dam/copapwp-pagov/en/pda/documents/consumer_protection/foodsafety/eggs/documents/eggs%20from%20small%20flock%20producers.pdf";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — PDA Limited Food Establishment registration (Food Safety
// Act, 3 Pa.C.S. §§ 5721–5737; agency framework, no cottage-food statute)
// ---------------------------------------------------------------------------

const cottageRegistration: RuleTemplate = {
  slug: "limited-food-registration",
  decision: "conditional",
  summary:
    "Pennsylvania has no cottage-food statute: processing food in a home residential kitchen is a 'limited food establishment' that must register with the Department of Agriculture, with plans reviewed and approved before production and sale.",
  citation_url: PA_LIMITED_FOOD,
  citation_title:
    "PDA Bureau of Food Safety & Laboratory Services — Limited Food Establishment Application Packet",
  statute_excerpt:
    "Processing/handling food from a home -residential kitchen ... According to The Food Safety Act (3 Pa.C.S.A. §§5721 – 5737) “…it shall be the duty of every person operating a food establishment within this Commonwealth to register…”",
  conditions: [
    "Application must be fully completed and reviewed by the regional Food Sanitarian/Supervisor prior to production and distribution or sale; PDA recommends applying 60 days before opening",
    "After approval, notify the regional office at least 10 days before production to arrange a registration inspection",
    "Acid and fermented foods must have a final equilibrium pH of 4.6 or below, with initial testing by a commercial laboratory",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageRegistration),
  oneChannel("retail", STATE, "cottage_food", cottageRegistration),
  oneChannel("wholesale", STATE, "cottage_food", cottageRegistration),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-fda-registration",
    decision: "conditional",
    summary:
      "PDA directs limited food establishments that want to sell interstate — which it notes includes internet sales — to contact their local FDA office and register with FDA before doing so.",
    citation_url: PA_LIMITED_FOOD,
    citation_title:
      "PDA Bureau of Food Safety & Laboratory Services — Limited Food Establishment Application Packet",
    statute_excerpt:
      "Processors wishing to sell their products interstate, which included internet sales, should contact their local FDA (Food and Drug Administration) office and become registered to do so.",
    conditions: [
      "FDA food facility registration is required for interstate (including internet) sales; the destination state's law also applies",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — 7 Pa. Code § 59a.402 (raw milk permit) + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const rawMilkPermit: RuleTemplate = {
  slug: "raw-milk-permit",
  decision: "conditional",
  summary:
    "Pennsylvania requires a current PDA raw milk permit to sell raw milk for human consumption; the permit authorizes the permitholder to produce and sell, within the Commonwealth, raw whole milk they produced — including through retail channels.",
  citation_url: PA_RAW_MILK,
  citation_title: "7 Pa. Code § 59a.402 — Raw milk; prohibitions",
  statute_excerpt:
    "(a) Sale of raw milk without permit. A person may not sell raw milk for human consumption without having a current raw milk permit issued by the Department. ... (b) Actions authorized under a raw milk permit. (1) A raw milk permit authorizes the permitholder to lawfully produce and sell, within this Commonwealth, raw whole milk for human consumption. The permit only authorizes the sale of raw milk that has been produced by the permitholder.",
  conditions: [
    "Current raw milk permit issued by the Department; only raw milk produced by the permitholder may be sold",
    "Sales must be within the Commonwealth of Pennsylvania",
    "Raw milk butter requires an additional permit and compliance with the butter-plant requirements of 7 Pa. Code §§ 59a.361–59a.363",
    "Testing, sanitation, and labeling requirements of 7 Pa. Code chapter 59a apply",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  ...forChannels(
    ["on_farm", "farmers_market", "retail", "online_intrastate"],
    STATE,
    "raw_milk",
    rawMilkPermit
  ),
  oneChannel("wholesale", STATE, "raw_milk", rawMilkPermit),
  oneChannel("herdshare", STATE, "raw_milk", {
    slug: "herdshare-is-a-sale",
    decision: "conditional",
    summary:
      "Pennsylvania treats herd-share and buyer's-club deliveries as sales: raw milk reaching a consumer through a cow herd share agreement or membership purchasing group requires the same PDA raw milk permit.",
    citation_url: PA_RAW_MILK,
    citation_title: "7 Pa. Code § 59a.402 — Raw milk; prohibitions",
    statute_excerpt:
      "The term ‘‘sell’’ also includes selling, exchanging or delivering to a consumer who is a member of a ‘‘buyer’s club,’’ cow herd share agreement or other type of membership purchasing group.",
    conditions: [
      "The farm behind the herd share must hold the PDA raw milk permit — the share agreement is not a permit substitute",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "raw_milk", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Federal law prohibits delivering, selling, or distributing raw milk in final package form for direct human consumption in interstate commerce; Pennsylvania's permit independently authorizes only sales within the Commonwealth.",
    citation_url: CFR_RAW_MILK,
    citation_title:
      "21 CFR 1240.61 — Mandatory pasteurization for milk in interstate commerce",
    statute_excerpt:
      "No person shall cause to be delivered into interstate commerce or shall sell, otherwise distribute, or hold for sale or other distribution after shipment in interstate commerce any milk or milk product in final package form for direct human consumption unless the product has been pasteurized or is made from dairy ingredients (milk or milk products) that have all been pasteurized, except where alternative procedures to pasteurization are provided for by regulation, such as in part 133 of this chapter for curing of certain cheese varieties.",
    conditions: [
      "7 Pa. Code § 59a.402(b)(1) independently limits permit-authorized raw milk sales to within the Commonwealth",
    ],
    effective_date: "1987-09-09",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// eggs — PDA Eggs from Small Flock Producers (retail-licensing exemption)
// ---------------------------------------------------------------------------

const eggSmallFlock: RuleTemplate = {
  slug: "small-flock-exemption",
  decision: "conditional",
  summary:
    "Pennsylvania exempts small-flock producers from retail licensing when they have fewer than 3,000 laying hens, sell directly on the farm or within a 100-mile radius, and keep eggs at 45°F or below from within 24 hours of lay until sale; the Retail Food Code still applies and inspection is still possible.",
  citation_url: PA_EGGS,
  citation_title: "PDA — Eggs from Small Flock Producers",
  statute_excerpt:
    "If a producer meets all the following requirements, they are exempt from retail licensing. Although exempt from licensing, producers are not exempt from requirements within the Retail FDA Food Code and may be subject to inspection. • Has less than 3,000 laying hens. • Sells directly on their farm or distributes within a 100-mile radius of their production or processing facility. • All eggs must be maintained in 45°F or less ambient air temperature within 24 hours of lay until the time of sale.",
  conditions: [
    "Fewer than 3,000 laying hens; direct on-farm sales or distribution within a 100-mile radius only",
    "Eggs held at 45°F or less ambient air temperature within 24 hours of lay until the time of sale",
    "The Retail Food Code requires that eggs sold directly to the consumer meet or exceed US Consumer Grade B standards",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggLabeling: RuleTemplate = {
  slug: "carton-labeling",
  decision: "conditional",
  summary:
    "Pennsylvania small-flock egg cartons must carry the producer's name and complete address with zip code, the date of lay, statement of identity, net contents, 'Keep Refrigerated', safe-handling instructions, and — if not graded to US standards — the word 'Unclassified'.",
  citation_url: PA_EGGS,
  citation_title: "PDA — Eggs from Small Flock Producers",
  statute_excerpt:
    "At any location, each carton, flat, or container of eggs must be labeled with the following information: Name and complete address including zip code; Date of lay ...; Statement of identity (eggs); Net Contents (at least 3/16-inch-high letters); \"Keep Refrigerated\"; Safe Handling Instructions ... If you are not grading your eggs to meet the US grade standards or US weight standards, then you must mark each carton/container of eggs as “Unclassified”.",
  conditions: [
    "If other than chicken eggs, the carton must name the species of fowl",
    "Bulk displays must post the date of lay and the identity of the small processor",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggLicensing: RuleTemplate = {
  slug: "retail-licensing",
  decision: "conditional",
  summary:
    "Egg sales outside the small-flock exemption — larger flocks, wider distribution, or sales through other channels — require Pennsylvania retail licensing and full Retail Food Code compliance.",
  citation_url: PA_EGGS,
  citation_title: "PDA — Eggs from Small Flock Producers",
  statute_excerpt:
    "If a producer meets all the following requirements, they are exempt from retail licensing. Although exempt from licensing, producers are not exempt from requirements within the Retail FDA Food Code and may be subject to inspection.",
  conditions: [
    "Producers not meeting every small-flock condition (3,000+ hens, distribution beyond 100 miles, or non-direct channels) need retail licensing",
    "Eggs must meet or exceed US Consumer Grade B standards when sold to consumers or used in retail food facilities",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggSmallFlock
  ),
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggLabeling
  ),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggLicensing),
  oneChannel("online_interstate", STATE, "eggs", eggLicensing),
  oneChannel("online_interstate", STATE, "eggs", {
    slug: "fda-egg-rule",
    decision: "conditional",
    summary:
      "Federally, shell-egg producers with 3,000 or more laying hens who do not sell all eggs directly to consumers are covered by the FDA egg safety rule (SE prevention, testing, refrigeration, registration) when shipping in interstate commerce.",
    citation_url: CFR_EGG,
    citation_title: "21 CFR 118.1 — Persons covered by the shell egg safety rule",
    statute_excerpt:
      "If you are a shell egg producer with 3,000 or more laying hens at a particular farm that does not sell all of your eggs directly to consumers and that produces shell eggs for the table market, you are covered by some or all of the requirements in this part",
    conditions: [
      "Farms with 3,000+ laying hens shipping interstate must register with FDA and comply with 21 CFR part 118 (Salmonella Enteritidis prevention measures, environmental and egg testing, refrigeration)",
    ],
    effective_date: "2009-09-08",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

export const pennsylvaniaRules: CorpusRule[] = [
  ...cottageFood,
  ...rawMilk,
  ...eggs,
];
