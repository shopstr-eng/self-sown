// Wedge corpus — TEXAS (TX). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (statutes.capitol.texas.gov,
// Texas Administrative Code, eCFR) and last verified by re-reading the source
// on 2026-11-07, reflecting SB 541 (effective 2025-09-01). Excerpts are
// verbatim from the cited text. Egg-row effective dates were filled on
// 2026-11-09 from the statutes.capitol.texas.gov history annotations (see
// inline notes); the 25 TAC raw-milk rows keep effective_date null because
// administrative rules carry no session-law date. The attorney reviewer must
// confirm every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "TX";
const VERIFIED = "2026-11-07";

const HS437 = "https://statutes.capitol.texas.gov/Docs/HS/htm/HS.437.htm";
const AG132 = "https://statutes.capitol.texas.gov/Docs/AG/htm/AG.132.htm";
const TAC_RAW_MILK =
  "https://regulations.justia.com/states/texas/title-25/part-1/chapter-217/subchapter-b/section-217-31";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — Health & Safety Code chapter 437 (as amended by SB 541,
// effective 2025-09-01)
// ---------------------------------------------------------------------------

const cottageNoPermit: RuleTemplate = {
  slug: "no-permit-required",
  decision: "conditional",
  summary:
    "Texas requires no license or permit for a cottage food production operation, and local health departments may not regulate production or require any permit or fee.",
  citation_url: HS437,
  citation_title:
    "HSC 437.0192 — Regulation by local government authorities prohibited",
  statute_excerpt:
    "A local government authority, including a local health department, may not: (1) regulate the production of food at a cottage food production operation; or (2) require a cottage food production operation to obtain any type of license or permit or pay any fee to produce or sell directly to a consumer or cottage food vendor...",
  conditions: [
    "Operation must stay within the chapter 437 definition: allowed foods, sales cap, and labeling all apply",
  ],
  effective_date: "2025-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageCap: RuleTemplate = {
  slug: "sales-cap",
  decision: "conditional",
  summary:
    "Cottage food annual gross income is capped at $150,000 (SB 541, raised from $50,000), adjusted annually for inflation by the department.",
  citation_url: HS437,
  citation_title: "HSC 437.001(2-b)(B) — Annual gross income cap",
  statute_excerpt:
    "has an annual gross income of $150,000 or less from the sale of food described by Paragraph (A), as the department annually adjusts for inflation using the Consumer Price Index for All Urban Consumers (CPI-U) published by the United States Bureau of Labor Statistics or its successor in function",
  conditions: [
    "Cap applies to annual gross income from cottage food sales; re-verify the department's inflation-adjusted figure each year",
  ],
  effective_date: "2025-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageProducts: RuleTemplate = {
  slug: "allowed-products",
  decision: "conditional",
  summary:
    "Texas allows a broad range of cottage foods (including time/temperature-control-for-safety foods after SB 541) but prohibits meat and poultry, seafood, ice and frozen desserts, low-acid canned goods, CBD/THC products, and raw milk.",
  citation_url: HS437,
  citation_title: "HSC 437.001(2-b)(A) — Excluded foods",
  statute_excerpt:
    "The definition excludes: meat, meat products, poultry, or poultry products; seafood, including seafood products, fish, fish products, shellfish, and shellfish products; ice or ice products, including shaved ice, ice cream, frozen custard, popsicles, and gelato; low-acid canned goods; products containing cannabidiol or tetrahydrocannabinol; and raw milk and raw milk products.",
  conditions: [
    "Time/temperature-control-for-safety (TCS) foods are permitted after SB 541 but carry extra labeling: the date the food was made and safe-handling instructions in at least 12-point font (HSC 437.0193)",
  ],
  effective_date: "2025-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every Texas cottage food product must be labeled with the operation's name and address (or department-issued unique ID) and the statutory disclosure that the product was produced in an uninspected private residence.",
  citation_url: HS437,
  citation_title: "HSC 437.0193 — Labeling requirements",
  statute_excerpt:
    "THIS PRODUCT WAS PRODUCED IN A PRIVATE RESIDENCE THAT IS NOT SUBJECT TO GOVERNMENTAL LICENSING OR INSPECTION.",
  conditions: [
    "Label must include the name and address of the operation, or a unique identification number issued by the department to a registered operation",
    "TCS foods must also show the date made and the safe-handling statement in at least 12-point font",
  ],
  effective_date: "2025-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageNoPermit),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageCap),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageProducts),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageLabeling),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "internet-personal-delivery",
    decision: "conditional",
    summary:
      "Internet sales are allowed only if the operator (or an employee/household member) personally delivers the food to the consumer and all required labeling information is posted on the website before payment.",
    citation_url: HS437,
    citation_title: "HSC 437.0194(b) — Internet sales conditions",
    statute_excerpt:
      "through the Internet only if: (1) the consumer purchases the food through the Internet from the operation and the operator or operator's employee or household member personally delivers the food to the consumer; and (2) ... before the operator accepts payment for the food, the operator provides all labeling information required by Section 437.0193(e) and department rules to the consumer by posting a legible statement on the operation's Internet website.",
    conditions: [
      "Personal delivery required — no common-carrier shipping under the internet-sales provision",
    ],
    effective_date: "2025-09-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-in-state-only",
    decision: "prohibited",
    summary:
      "Texas cottage food sales are defined as in-state transactions: foods must be sold in this state directly to consumers or cottage food vendors, so interstate mail-order sales are outside the exemption.",
    citation_url: HS437,
    citation_title: "HSC 437.0194(c) — In-state sales limitation",
    statute_excerpt:
      "The operator of a cottage food production operation that sells a food in this state in the manner described by Subsection (b)...",
    conditions: [],
    effective_date: "2025-09-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-vendor-only",
    decision: "conditional",
    summary:
      "Wholesale is prohibited except sales to a registered 'cottage food vendor' for foods that are not time/temperature-control-for-safety foods or otherwise prohibited items (SB 541).",
    citation_url: HS437,
    citation_title: "HSC 437.0194(a), (a-1) — Wholesale restriction",
    statute_excerpt:
      "Except as provided by Subsection (a-1), a cottage food production operation may not sell food at wholesale.",
    conditions: [
      "Exception: sales at wholesale to a cottage food vendor, limited to non-TCS, non-prohibited foods",
    ],
    effective_date: "2025-09-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "retail-vendor-only",
    decision: "conditional",
    summary:
      "Retail sale through a store is possible only through a registered 'cottage food vendor' reselling non-TCS cottage foods; the operation itself may not otherwise sell at wholesale or to retail establishments.",
    citation_url: HS437,
    citation_title: "HSC 437.0194(a), (a-1) — Wholesale restriction",
    statute_excerpt:
      "Except as provided by Subsection (a-1), a cottage food production operation may not sell food at wholesale.",
    conditions: [
      "Only non-TCS, non-prohibited foods may flow through a cottage food vendor",
    ],
    effective_date: "2025-09-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — 25 TAC 217.31 (Grade A Raw for Retail) + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const rawMilkRetailPermit: RuleTemplate = {
  slug: "grade-a-raw-for-retail-permit",
  decision: "conditional",
  summary:
    "Texas raw milk sales require a Grade A Raw for Retail Permit; sales may occur on the dairy farm directly to the consumer or by delivery to a location agreed by the processor and customer (subject to local ordinance), in refrigerated sanitary equipment.",
  citation_url: TAC_RAW_MILK,
  citation_title: "25 TAC 217.31 — Sale of Raw Milk to the Consumer",
  statute_excerpt:
    "Grade A raw milk and Grade A raw milk products may be sold by the Grade A raw milk processor directly to the consumer at the raw milk processor dairy farm, provided that such producer has been issued a Grade A Raw for Retail Permit in accordance with §217.91 of this title... Grade A raw milk and Grade A raw milk products may be delivered by the permitted processor, or the permitted processor's employee, to a location determined by the processor and customer, as long as the distribution does not violate a local ordinance",
  conditions: [
    "Grade A Raw for Retail Permit under 25 TAC 217.91, with the testing and sanitation requirements of 25 TAC chapter 217, subchapter B",
    "Delivery must use refrigerated sanitary equipment and may not violate a local ordinance",
    "No retail-store or farmers-market sales are authorized by the rule",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  oneChannel("on_farm", STATE, "raw_milk", rawMilkRetailPermit),
  oneChannel("online_intrastate", STATE, "raw_milk", rawMilkRetailPermit),
  oneChannel("farmers_market", STATE, "raw_milk", {
    slug: "farmers-market-not-authorized",
    decision: "prohibited",
    summary:
      "Texas's Grade A Raw for Retail rule authorizes only on-farm sales and direct delivery; farmers-market sales of raw milk are not an authorized channel.",
    citation_url: TAC_RAW_MILK,
    citation_title: "25 TAC 217.31 — Sale of Raw Milk to the Consumer",
    statute_excerpt:
      "Grade A raw milk and Grade A raw milk products may be sold by the Grade A raw milk processor directly to the consumer at the raw milk processor dairy farm... Grade A raw milk and Grade A raw milk products may be delivered by the permitted processor, or the permitted processor's employee, to a location determined by the processor and customer",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("retail", STATE, "raw_milk", {
    slug: "retail-store-not-authorized",
    decision: "prohibited",
    summary:
      "Retail-store sale of raw milk is not authorized in Texas; the Grade A Raw for Retail Permit covers only on-farm sales and direct delivery to the consumer.",
    citation_url: TAC_RAW_MILK,
    citation_title: "25 TAC 217.31 — Sale of Raw Milk to the Consumer",
    statute_excerpt:
      "Grade A raw milk and Grade A raw milk products may be sold by the Grade A raw milk processor directly to the consumer at the raw milk processor dairy farm... Grade A raw milk and Grade A raw milk products may be delivered by the permitted processor, or the permitted processor's employee, to a location determined by the processor and customer",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "raw_milk", {
    slug: "wholesale-not-authorized",
    decision: "prohibited",
    summary:
      "Wholesale distribution of raw milk for direct human consumption is not authorized in Texas; permitted sales run directly from the processor to the consumer only.",
    citation_url: TAC_RAW_MILK,
    citation_title: "25 TAC 217.31 — Sale of Raw Milk to the Consumer",
    statute_excerpt:
      "Grade A raw milk and Grade A raw milk products may be sold by the Grade A raw milk processor directly to the consumer at the raw milk processor dairy farm...",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
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
// eggs — Agriculture Code chapter 132 (license; own-flock exemption)
// ---------------------------------------------------------------------------

const eggOwnFlock: RuleTemplate = {
  slug: "own-flock-exemption",
  decision: "conditional",
  summary:
    "Texas's egg licensing chapter does not apply to a person selling only eggs from their own flock without claiming a grade — small producers may sell ungraded eggs direct to consumers without an egg license, labeled with the producer's name and address.",
  citation_url: AG132,
  citation_title: "Agriculture Code 132.002 — Limitation of chapter",
  statute_excerpt:
    "This chapter does not apply to a person selling only eggs that are produced by the person's own flock and for which the person does not claim a grade.",
  conditions: [
    "Eggs must come only from the seller's own flock, with no grade claim",
    "4 TAC 15.2: exempt producers must identify their eggs as 'Produced by (producer's name)' and give their address",
  ],
  // Enacted Acts 1981, 67th Leg., ch. 388 §1, effective 1981-09-01 per the
  // statutes.capitol.texas.gov history annotation.
  effective_date: "1981-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggLicense: RuleTemplate = {
  slug: "egg-license",
  decision: "conditional",
  summary:
    "Buying or selling eggs for resale in Texas — including grading or first establishing grade/size/classification — requires an egg license from the Department of Agriculture; retailers selling to ultimate consumers are exempt.",
  citation_url: AG132,
  citation_title: "Agriculture Code 132.021 — License required",
  statute_excerpt:
    "A person may not buy or sell eggs in this state for the purpose of resale without first obtaining a license from the department.",
  conditions: [
    "Each separate facility where eggs are graded, stored, packed, or processed needs a license (4 TAC 15.2)",
    "Exemptions: own-flock ungraded producers (Ag. Code 132.002) and retailers selling to the ultimate consumer (Ag. Code 132.021)",
  ],
  // Current amendment: Acts 1995, 74th Leg., ch. 419 §10.09(16), effective
  // 1995-09-01 per the statutes.capitol.texas.gov history annotation
  // (originally enacted Acts 1981, 67th Leg., ch. 388 §1, effective
  // 1981-09-01).
  effective_date: "1995-09-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggOwnFlock
  ),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggLicense),
  oneChannel("online_interstate", STATE, "eggs", eggLicense),
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

export const texasRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
