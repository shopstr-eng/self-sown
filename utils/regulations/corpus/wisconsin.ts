// Wedge corpus — WISCONSIN (WI). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (Wisconsin Statutes on
// docs.legis.wisconsin.gov, DATCP home-bakers guidance, eCFR) and last
// verified by re-reading the source on 2026-11-08. Excerpts are verbatim
// from the cited text. Wisconsin has no comprehensive cottage-food statute:
// home-canned acid foods ride the narrow "pickle bill" exemption in
// s. 97.29(2)(b)2, and home-baked goods ride a court ruling DATCP does not
// enforce against (tier agency_guidance). Effective dates are null pending
// session-law verification; the attorney reviewer must confirm every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "WI";
const VERIFIED = "2026-11-08";

const WIS_97_29 =
  "https://docs.legis.wisconsin.gov/statutes/statutes/97/ii/29/2/b?view=section";
const WI_HOME_BAKERS =
  "https://datcp.wi.gov/Pages/Licenses_Permits/HomeBakers.aspx";
const WIS_97_24 =
  "https://docs.legis.wisconsin.gov/statutes/statutes/97/ii/24?view=section";
const WIS_97_28 =
  "https://docs.legis.wisconsin.gov/statutes/statutes/97/ii/28/2?view=section";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — s. 97.29(2)(b)2 (pickle bill) + DATCP home-bakers guidance
// (2017 Lafayette County ruling)
// ---------------------------------------------------------------------------

// Wisconsin's two cottage-food exemptions split by PRODUCT, not by channel:
// home-canned acid foods ride the pickle bill, non-potentially-hazardous
// baked goods ride the court ruling. The engine merges every row in a
// state × category × channel slot into one answer, so each channel gets ONE
// row whose conditions are explicitly product-scoped — parallel exemption
// rows would conflate the pickle-bill cap/sign with the baked-goods ruling.

const cottageFood: CorpusRule[] = [
  oneChannel("farmers_market", STATE, "cottage_food", {
    slug: "product-scoped-exemptions",
    decision: "conditional",
    summary:
      "At a Wisconsin farmers' market, which exemption applies depends on the product: home-canned acid foods ride the statutory 'pickle bill' (under $5,000/yr, sign, labels), while non-potentially-hazardous baked goods ride the 2017 home-bakers court ruling DATCP does not enforce; every other home-produced food needs a food processing plant license.",
    citation_url: WIS_97_29,
    citation_title:
      "Wis. Stat. § 97.29(2)(b)2 — Home-canned foods licensing exemption",
    statute_excerpt:
      "A person is not required to obtain a license under this section to sell at retail food products that the person prepares and cans at home in this state if all of the following apply: a. The food products are pickles or other processed vegetables or fruits with an equilibrium pH value of 4.6 or lower. b. The person sells the food products at a community or social event or a farmers' market in this state. c. The person receives less than $5,000 per year from the sale of the food products. d. The person displays a sign at the place of sale stating: “These canned goods are homemade and not subject to state inspection.”",
    conditions: [
      "Home-canned pickles and other processed vegetables or fruits (equilibrium pH 4.6 or lower): under $5,000 per year, the statutory sign at the place of sale, and each container labeled with the preparer's name and address, the date canned, the statement “This product was made in a private home not subject to state licensing or inspection.”, and ingredients in descending order of prominence",
      "Non-potentially-hazardous baked goods only: no license under the 2017 Lafayette County Circuit Court decision DATCP does not enforce (DATCP 'Licenses and Homemade Baked Goods' page), sold directly to consumers; the Court of Appeals (Nov. 19, 2024) refused to extend that ruling beyond baked goods",
      "Any other home-produced food (including home-canned goods outside the pickle-bill conditions) requires a s. 97.29 food processing plant license",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("on_farm", STATE, "cottage_food", {
    slug: "home-baked-goods-ruling",
    decision: "conditional",
    summary:
      "On-farm, only non-potentially-hazardous baked goods are covered by a Wisconsin exemption — the 2017 home-bakers ruling DATCP does not enforce, limited to direct-to-consumer sales; the pickle bill's venues are community/social events and farmers' markets only, so home-canned foods and all other products need a food processing plant license.",
    citation_url: WI_HOME_BAKERS,
    citation_title: "DATCP — Licenses and Homemade Baked Goods",
    statute_excerpt:
      "A 2017 Lafayette County Circuit Court decision, and later court clarifications, prohibited enforcement of licensing requirements for home bakers who make baked goods that are not potentially hazardous and sell those items directly to consumers.",
    conditions: [
      "Non-potentially-hazardous baked goods made in the producer's home, sold directly to consumers, only",
      "Home-canned foods are NOT covered here — the pickle bill (Wis. Stat. § 97.29(2)(b)2.b) limits those sales to community or social events and farmers' markets in this state",
      "Any other home-produced food requires a s. 97.29 food processing plant license",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "home-baked-goods-ruling",
    decision: "conditional",
    summary:
      "For in-state internet sales, only non-potentially-hazardous baked goods are covered by a Wisconsin exemption — the 2017 home-bakers ruling DATCP does not enforce, limited to direct-to-consumer sales; the pickle bill's venues are community/social events and farmers' markets only, so home-canned foods and all other products need a food processing plant license.",
    citation_url: WI_HOME_BAKERS,
    citation_title: "DATCP — Licenses and Homemade Baked Goods",
    statute_excerpt:
      "A 2017 Lafayette County Circuit Court decision, and later court clarifications, prohibited enforcement of licensing requirements for home bakers who make baked goods that are not potentially hazardous and sell those items directly to consumers.",
    conditions: [
      "Non-potentially-hazardous baked goods made in the producer's home, sold directly to consumers, only",
      "Home-canned foods are NOT covered online — the pickle bill (Wis. Stat. § 97.29(2)(b)2.b) limits those sales to community or social events and farmers' markets in this state",
      "Any other home-produced food requires a s. 97.29 food processing plant license",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-uncovered",
    decision: "conditional",
    summary:
      "No Wisconsin exemption squarely covers interstate cottage food sales: the pickle bill is venue-limited to in-state community/social events and farmers' markets, so home-canned foods may not ship interstate without a s. 97.29 food processing plant license, and the home-baked-goods ruling speaks only to sales 'directly to consumers' without addressing interstate mail order — DATCP has not answered the interstate question for baked goods, so the agency contact path applies.",
    citation_url: WI_HOME_BAKERS,
    citation_title: "DATCP — Licenses and Homemade Baked Goods",
    statute_excerpt:
      "A 2017 Lafayette County Circuit Court decision, and later court clarifications, prohibited enforcement of licensing requirements for home bakers who make baked goods that are not potentially hazardous and sell those items directly to consumers.",
    conditions: [
      "Home-canned foods: outside the pickle bill's venues (Wis. Stat. § 97.29(2)(b)2.b), so interstate shipment requires a s. 97.29 food processing plant license and FDA compliance",
      "Home-baked goods: DATCP has not addressed whether the ruling reaches interstate mail order — confirm with DATCP before shipping out of state",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "retail-not-covered",
    decision: "prohibited",
    summary:
      "Neither Wisconsin exemption reaches retail stores: the pickle bill limits home-canned food sales to community/social events and farmers' markets in this state, and the home-baked-goods ruling covers only sales directly to consumers — retail placement requires a food processing plant license.",
    citation_url: WI_HOME_BAKERS,
    citation_title: "DATCP — Licenses and Homemade Baked Goods",
    statute_excerpt:
      "A 2017 Lafayette County Circuit Court decision, and later court clarifications, prohibited enforcement of licensing requirements for home bakers who make baked goods that are not potentially hazardous and sell those items directly to consumers.",
    conditions: [
      "Pickle bill venue limit for home-canned foods: “The person sells the food products at a community or social event or a farmers' market in this state.” (Wis. Stat. § 97.29(2)(b)2.b)",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-not-covered",
    decision: "prohibited",
    summary:
      "Wholesale distribution of home-produced food is outside both Wisconsin exemptions — the pickle bill's venue limit for home-canned foods and the ruling's direct-to-consumer limit for baked goods — so a food processing plant license under s. 97.29 is required.",
    citation_url: WI_HOME_BAKERS,
    citation_title: "DATCP — Licenses and Homemade Baked Goods",
    statute_excerpt:
      "A 2017 Lafayette County Circuit Court decision, and later court clarifications, prohibited enforcement of licensing requirements for home bakers who make baked goods that are not potentially hazardous and sell those items directly to consumers.",
    conditions: [
      "Pickle bill venue limit for home-canned foods: “The person sells the food products at a community or social event or a farmers' market in this state.” (Wis. Stat. § 97.29(2)(b)2.b)",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — Wis. Stat. § 97.24(2) (grade A/pasteurization requirement with
// narrow incidental on-farm exception) + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const rawMilkIncidental: RuleTemplate = {
  slug: "incidental-on-farm-sales",
  decision: "conditional",
  summary:
    "Wisconsin requires all milk sold to consumers to be grade A and effectively pasteurized, with one narrow exception: incidental sales of milk directly to consumers at the dairy farm where the milk is produced.",
  citation_url: WIS_97_24,
  citation_title:
    "Wis. Stat. § 97.24(2)(d)2 — Incidental on-farm sales exception",
  statute_excerpt:
    "This section does not prohibit: ... 2. Incidental sales of milk directly to consumers at the dairy farm where the milk is produced.",
  conditions: [
    "Sales must be incidental, directly to consumers, and at the dairy farm where the milk is produced — regular or advertised raw-milk sales fall outside the exception",
    "DATCP reads 'incidental' narrowly; recurring raw-milk distribution has drawn enforcement — treat any scale beyond incidental as prohibited",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilkProhibited: RuleTemplate = {
  slug: "non-grade-a-sale-prohibited",
  decision: "prohibited",
  summary:
    "Outside the incidental on-farm exception, Wisconsin prohibits selling or distributing non-grade-A or unpasteurized milk to consumers, restaurants, institutions, or retailers — no farmers-market, retail, wholesale, or delivery channel exists for raw milk.",
  citation_url: WIS_97_24,
  citation_title:
    "Wis. Stat. § 97.24(2)(b) — Grade A and pasteurization requirement",
  statute_excerpt:
    "No person may sell or distribute any milk or fluid milk products which are not grade A milk or grade A milk products to consumers, or to any restaurant, institution or retailer for consumption or resale to consumers. Grade A milk and grade A milk products shall be effectively pasteurized, and shall be produced, processed and distributed in compliance with standards established by the department by rule under this chapter.",
  conditions: [],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  oneChannel("on_farm", STATE, "raw_milk", rawMilkIncidental),
  ...forChannels(
    ["farmers_market", "retail", "wholesale", "online_intrastate"],
    STATE,
    "raw_milk",
    rawMilkProhibited
  ),
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
// eggs — Wis. Stat. § 97.28 (direct sale of eggs; ≤150-bird exemption)
// ---------------------------------------------------------------------------

const eggDirectSale: RuleTemplate = {
  slug: "small-flock-direct-exemption",
  decision: "conditional",
  summary:
    "A Wisconsin egg producer with 150 or fewer laying birds may sell eggs — including unwashed, ungraded nest-run eggs — without a s. 97.29 license, but only directly to consumers at the farm premises, at a Wisconsin farmers' market, or on an egg sales route.",
  citation_url: WIS_97_28,
  citation_title: "Wis. Stat. § 97.28(2) — Direct sale of eggs exemption",
  statute_excerpt:
    "An egg producer who satisfies all of the following need not obtain a license under s. 97.29 to sell eggs, including nest-run eggs: (a) The number of egg-laying birds in the egg producer's flock does not exceed 150. (b) The egg producer sells the eggs directly to a consumer through one of the following venues: 1. At the premises where the eggs were laid. 2. At a farmers' market located in this state. 3. On an egg sales route.",
  conditions: [
    "Flock of 150 or fewer egg-laying birds; eggs laid only by the producer's own flock",
    "Exempt sales must be direct to the consumer at the laying premises, a Wisconsin farmers' market, or an egg sales route (regular residential route)",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggLabeling: RuleTemplate = {
  slug: "exempt-carton-labeling",
  decision: "conditional",
  summary:
    "License-exempt Wisconsin egg cartons may be labeled only with the producer's name and address, the packing date, a sell-by date no more than 30 days after packing, and a statement that the eggs are ungraded and uninspected.",
  citation_url: WIS_97_28,
  citation_title: "Wis. Stat. § 97.28(2)(c) — Exempt egg carton labeling",
  statute_excerpt:
    "The egg producer packages the eggs in a carton that is labeled only with the following information: 1. The egg producer's name and address. 2. The date on which the egg producer packed the eggs into the carton. 3. A date that falls no more than 30 days after the date on which the eggs were packed by which the eggs must be sold. 4. A statement indicating that the eggs in the package are ungraded and uninspected.",
  conditions: [
    "The statute says 'labeled only with' — additional label claims can forfeit the exemption",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggLicense: RuleTemplate = {
  slug: "food-processing-license",
  decision: "conditional",
  summary:
    "Egg sales beyond the ≤150-bird direct-sale exemption — larger flocks, retail stores, wholesale, or other channels — require a Wisconsin food processing plant license under s. 97.29.",
  citation_url: WIS_97_28,
  citation_title: "Wis. Stat. § 97.28(2) — Direct sale of eggs exemption",
  statute_excerpt:
    "An egg producer who satisfies all of the following need not obtain a license under s. 97.29 to sell eggs, including nest-run eggs: (a) The number of egg-laying birds in the egg producer's flock does not exceed 150. (b) The egg producer sells the eggs directly to a consumer through one of the following venues: 1. At the premises where the eggs were laid. 2. At a farmers' market located in this state. 3. On an egg sales route.",
  conditions: [
    "Any condition missed — flock over 150 birds or a non-exempt channel — means the producer needs the s. 97.29 license and full grading/candling compliance",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggDirectSale
  ),
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggLabeling
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

export const wisconsinRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
