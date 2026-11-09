// Wedge corpus — CALIFORNIA (CA). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (leginfo.legislature.ca.gov
// statutory text, CDFA/CDPH program pages, eCFR) and last verified by
// re-reading the source on 2026-11-07. Excerpts are verbatim from the cited
// text. Statutory effective dates were filled on 2026-11-09 from the
// leginfo.legislature.ca.gov history lines (see inline notes); the CDFA
// program-page rows keep effective_date null because guidance carries no
// effective date. The attorney reviewer must confirm every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "CA";
const VERIFIED = "2026-11-07";

const HSC =
  "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=HSC&sectionNum=";
const CDFA_RAW_MILK =
  "https://www.cdfa.ca.gov/ahfss/Milk_and_Dairy_Food_Safety/rawmilk.html";
const CDFA_ESQM = "https://www.cdfa.ca.gov/AHFSS/MPES/esqm.html";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — HSC 113758 (definitions), 114365 (operations), 114365.2
// (labeling)
// ---------------------------------------------------------------------------

const cottageClassA: RuleTemplate = {
  slug: "class-a-registration",
  decision: "conditional",
  summary:
    "A Class A cottage food operation may make only direct sales to consumers (at the home, farmers markets, and other direct venues) and must register with the local enforcement agency with an approved self-certification checklist; verifiable gross annual sales are capped at the CPI-adjusted statutory limit ($86,206 for 2025).",
  citation_url: `${HSC}114365`,
  citation_title: "HSC 114365 — Class A registration and self-certification",
  statute_excerpt:
    "A “Class A” cottage food operation shall not be open for business unless it is registered with the local enforcement agency and has submitted a completed, self-certification checklist approved by the local enforcement agency.",
  conditions: [
    "Direct sales only — no indirect sales through stores or restaurants",
    "Annual gross sales cap: $75,000 statutory, adjusted annually for inflation — $86,206 for 2025 per CDPH",
    "Self-certification checklist covers kitchen-use restrictions (no concurrent domestic activity, no infants/small children/pets in the kitchen during preparation)",
    "Direct sales transactions may be made via phone, internet, or other digital method, but delivery must be in person within California",
  ],
  // Current amendment: AB 1144 (Stats 2021 ch. 178 §2), effective 2022-01-01
  // per the leginfo history line.
  effective_date: "2022-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every California cottage food product must be labeled with the words 'Made in a Home Kitchen' (or 'Repackaged in a Home Kitchen') in 12-point type, the product name, the operation's name, its registration or permit number and issuing county, and ingredients in descending order by weight.",
  citation_url: `${HSC}114365.2`,
  citation_title: "HSC 114365.2(e) — Cottage food product labeling",
  statute_excerpt:
    "The label shall include, but is not limited to, all of the following: (1) The words “Made in a Home Kitchen” or “Repackaged in a Home Kitchen,” as applicable, with a description of any purchased whole ready-to-eat product not used as an ingredient in 12-point type on the cottage food product’s primary display panel. ... (4) The registration or permit number of the “Class A” or “Class B” cottage food operation, respectively, which produced the cottage food product and the name of the county of the local enforcement agency that issued the permit or registration number. (5) The ingredients of the cottage food product, in descending order of predominance by weight, if the product contains two or more ingredients.",
  conditions: [
    "Label must also comply with the Federal Food, Drug, and Cosmetic Act (21 U.S.C. Sec. 343 et seq.), including allergen declaration",
  ],
  // Current amendment: AB 831 (Stats 2021 ch. 155 §9), effective 2022-01-01
  // per the leginfo history line.
  effective_date: "2022-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageClassA),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageLabeling),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "class-b-indirect",
    decision: "conditional",
    summary:
      "Indirect sales through third-party retail food facilities require a Class B cottage food operation permit from the local enforcement agency, issued after an initial inspection; the Class B gross annual sales cap is CPI-adjusted ($172,411 for 2025).",
    citation_url: `${HSC}113758`,
    citation_title: "HSC 113758 — Class B cottage food operation definition",
    statute_excerpt:
      "A “Class B” cottage food operation ... is a cottage food operation that may engage in both direct sales and indirect sales of cottage food products from the cottage food operation, from direct sales venues ... from offsite events, or from a third-party retail food facility",
    conditions: [
      "Class B permit from the local enforcement agency after initial inspection (HSC 114365)",
      "Annual gross sales cap: $150,000 statutory, adjusted annually for inflation — $172,411 for 2025 per CDPH",
    ],
    // Current amendment: AB 1144 (Stats 2021 ch. 178 §1), effective
    // 2022-01-01 per the leginfo history line.
    effective_date: "2022-01-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "class-b-indirect",
    decision: "conditional",
    summary:
      "Wholesale-type indirect sales are lawful only for Class B operations selling through third-party retail food facilities, under the Class B permit and its CPI-adjusted sales cap.",
    citation_url: `${HSC}113758`,
    citation_title: "HSC 113758 — Class B cottage food operation definition",
    statute_excerpt:
      "A “Class B” cottage food operation ... is a cottage food operation that may engage in both direct sales and indirect sales of cottage food products from the cottage food operation, from direct sales venues ... from offsite events, or from a third-party retail food facility",
    conditions: [
      "Class B permit from the local enforcement agency after initial inspection (HSC 114365)",
      "Annual gross sales cap: $150,000 statutory, adjusted annually for inflation — $172,411 for 2025 per CDPH",
    ],
    // Current amendment: AB 1144 (Stats 2021 ch. 178 §1), effective
    // 2022-01-01 per the leginfo history line.
    effective_date: "2022-01-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "California defines a 'direct sale' as a transaction within the state between the cottage food operation and a consumer — cottage food may not be sold across state lines.",
    citation_url: `${HSC}113758`,
    citation_title: "HSC 113758 — Direct sale definition",
    statute_excerpt:
      "“Direct sale” means a transaction within the state between a cottage food operation and a consumer, in which the consumer purchases the cottage food product directly from the cottage food operation.",
    conditions: [],
    // Current amendment: AB 1144 (Stats 2021 ch. 178 §1), effective
    // 2022-01-01 per the leginfo history line.
    effective_date: "2022-01-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — FAC Div. 15 (retail-legal Grade A raw milk) + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const RAW_MILK_CHANNELS = [
  "retail",
  "on_farm",
  "farmers_market",
  "online_intrastate",
  "wholesale",
];

const rawMilkPermit: RuleTemplate = {
  slug: "market-milk-permit",
  decision: "conditional",
  summary:
    "California is a retail-legal raw milk state: raw milk for human consumption must come from a dairy farm holding a market milk permit from CDFA or a County Approved Milk Inspection Service, meeting Grade A raw milk bacterial, herd-health, and sanitation standards.",
  citation_url: CDFA_RAW_MILK,
  citation_title: "CDFA — Raw Milk Requirements Summary",
  statute_excerpt:
    "Raw milk must be produced on a dairy farm that holds a market milk permit issued by either CDFA or a County Approved Milk Inspection Service (FAC § 33222), and scores not less than 90 percent on the market milk dairy farm sanitation scorecard (FAC § 35891).",
  conditions: [
    "All dairy livestock must test negative for brucellosis (FAC § 35601) and nonreactive for tuberculosis at least annually (FAC § 32903)",
    "Bacterial limits: not more than 15,000 bacteria/mL or 10 coliform/mL; somatic cell limits 600,000/mL (cow) and 1,500,000/mL (goat) (FAC § 35781; 3 CCR § 625)",
    "Raw milk must be cooled to and held at 45°F or below within specified timeframes",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const rawMilk: CorpusRule[] = [
  ...forChannels(RAW_MILK_CHANNELS, STATE, "raw_milk", rawMilkPermit),
  oneChannel("online_interstate", STATE, "raw_milk", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Federal law prohibits delivering, selling, or distributing raw milk in final package form for direct human consumption in interstate commerce; only pasteurized milk may cross state lines (limited aged-cheese exception under 21 CFR part 133).",
    citation_url: CFR_RAW_MILK,
    citation_title:
      "21 CFR 1240.61 — Mandatory pasteurization for milk in interstate commerce",
    statute_excerpt:
      "No person shall cause to be delivered into interstate commerce or shall sell, otherwise distribute, or hold for sale or other distribution after shipment in interstate commerce any milk or milk product in final package form for direct human consumption unless the product has been pasteurized or is made from dairy ingredients (milk or milk products) that have all been pasteurized, except where alternative procedures to pasteurization are provided for by regulation, such as in part 133 of this chapter for curing of certain cheese varieties.",
    conditions: [],
    effective_date: "1987-09-09",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// eggs — CDFA Egg Safety & Quality Management (ESQM) registration
// ---------------------------------------------------------------------------

const eggRegistration: RuleTemplate = {
  slug: "handler-registration",
  decision: "conditional",
  summary:
    "California requires everyone producing, grading, packing, selling, or marketing eggs to register as an egg handler with CDFA's Egg Safety and Quality Management program — there are no small-flock exemptions.",
  citation_url: CDFA_ESQM,
  citation_title: "CDFA — Egg Safety and Quality Management (ESQM)",
  statute_excerpt:
    "Anyone involved in producing, candling, grading, packing, or otherwise preparing eggs, or anyone selling or marketing eggs must register as an egg handler. ... There are no exemptions to the registration requirement.",
  conditions: [
    "Registration applies regardless of flock size — even hobbyists and those donating eggs",
    "Assessment of $0.10 per 30-dozen case of eggs sold through June 30, 2026; $0.13 per case beginning July 1, 2026",
    "Container labeling: name/address/zip, quantity, 'keep refrigerated,' handler code, sell-by date, CA SEFS Compliant statement, size, grade, and Julian pack date",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "retail", "wholesale", "online_intrastate"],
    STATE,
    "eggs",
    eggRegistration
  ),
  oneChannel("online_interstate", STATE, "eggs", eggRegistration),
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

export const californiaRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
