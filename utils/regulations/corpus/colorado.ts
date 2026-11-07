// Wedge corpus — COLORADO (CO). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source and last verified by
// re-reading the source on 2026-11-07. Excerpts are verbatim.
//
// CITATION HOST NOTE: Colorado's official C.R.S. public access is a
// LexisNexis-hosted portal (via leg.colorado.gov) that is not deep-linkable
// per section. Rows cite law.justia.com, which reproduces the official
// statute text; the attorney reviewer must confirm each excerpt against the
// official C.R.S. before launch.
//
// KNOWN PENDING CHANGE: HB26-1033 ("Tamale Act") passed in 2026 and takes
// effect 2027-01-01 per CDPHE (https://cdphe.colorado.gov/dehs/cottage-foods)
// — the cottage_food rows must be re-encoded when it lands. Tracked in
// docs/regulations-wedge-decision.md.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "CO";
const VERIFIED = "2026-11-07";

const CRS_COTTAGE =
  "https://law.justia.com/codes/colorado/title-25/disease-control/article-4/part-16/section-25-4-1614/";
const CRS_RAW_MILK =
  "https://law.justia.com/codes/colorado/title-25/products-control-and-safety/article-5-5/part-1/section-25-5-5-117/";
const CRS_EGG_EXEMPTION =
  "https://law.justia.com/codes/colorado/title-35/poultry-and-rabbits/article-21/part-1/section-35-21-105/";
const CRS_EGG_LICENSE =
  "https://law.justia.com/codes/colorado/title-35/poultry-and-rabbits/article-21/part-1/section-35-21-104/";
const ECFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const ECFR_EGG_RULE =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — C.R.S. § 25-4-1614 (Colorado Cottage Foods Act)
// ---------------------------------------------------------------------------

const cottageProducts: RuleTemplate = {
  slug: "allowed-products",
  decision: "conditional",
  summary:
    "Cottage food sales are limited to non-potentially-hazardous foods needing no refrigeration: pickled fruits and vegetables, spices, teas, dehydrated produce, nuts, seeds, honey, jams, jellies, preserves, fruit butter, flour, and baked goods including candies, fruit empanadas, and tortillas — plus whole eggs up to 250 dozen per month.",
  citation_url: CRS_COTTAGE,
  citation_title: "C.R.S. § 25-4-1614(2)(b) — Colorado Cottage Foods Act: eligible foods",
  statute_excerpt:
    "A producer is permitted under this section to sell only a limited range of foods that have been produced, processed, or packaged that are nonpotentially hazardous and do not require refrigeration. These foods include pickled fruits and vegetables, spices, teas, dehydrated produce, nuts, seeds, honey, jams, jellies, preserves, fruit butter, flour, and baked goods, including candies, fruit empanadas, and tortillas, and other nonpotentially hazardous foods. ... A person may sell whole eggs under this section; except that a person may not sell more than two hundred fifty dozen whole eggs per month under this section. A person selling whole eggs must meet the requirements of section 35-21-105, C.R.S.",
  conditions: [
    "CDPHE requires pickled fruits and vegetables to reach a finished equilibrium pH of 4.6 or below",
    "Ineligible per CDPHE: any meat product (including as an ingredient or topping), baked or fried goods with cream, custard, or meringue fillings or toppings, and any food requiring refrigeration",
    "Whole eggs are capped at 250 dozen per month and must meet C.R.S. § 35-21-105 transport and labeling rules",
  ],
  effective_date: "2016-05-04",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageCourse: RuleTemplate = {
  slug: "food-safety-course",
  decision: "conditional",
  summary:
    "Producers must complete a food safety course comparable to the Colorado State University Extension cottage food training (or one from a state, county, or district public health agency) and stay in good standing.",
  citation_url: CRS_COTTAGE,
  citation_title: "C.R.S. § 25-4-1614(2)(c) — Cottage Foods Act: food safety course",
  statute_excerpt:
    "A producer must take a food safety course that includes basic food handling training and is comparable to, or is a course given by, the Colorado state university extension service or a state, county, or district public health agency, and must maintain a status of good standing in accordance with the course requirements, including attending any additional classes if necessary.",
  conditions: [
    "CSU Extension certificates are valid for three years; an online food handlers card or a local public health agency course also qualifies (CDPHE guidance)",
  ],
  effective_date: "2016-05-04",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageCap: RuleTemplate = {
  slug: "revenue-cap",
  decision: "conditional",
  summary:
    "Cottage food sales are capped at $10,000 in net revenue per eligible food product per calendar year.",
  citation_url: CRS_COTTAGE,
  citation_title: "C.R.S. § 25-4-1614(2)(e) — Cottage Foods Act: revenue cap",
  statute_excerpt:
    "This section applies only to producers who earn net revenues of ten thousand dollars or less per calendar year from the sale of each eligible food product produced in the producer's home kitchen or a commercial, private, or public kitchen.",
  conditions: [
    "The cap is net revenue (not gross), per eligible food product, per calendar year",
    "The producer must be a Colorado resident individual or a Colorado LLC of two or fewer resident members (C.R.S. § 25-4-1614(9)(c))",
  ],
  effective_date: "2016-05-04",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Each product needs a label with product identification; producer name, preparation address, and phone or email; production date; full ingredient list; and the statutory home-kitchen disclaimer — plus a point-of-sale placard with the shorter disclaimer.",
  citation_url: CRS_COTTAGE,
  citation_title: "C.R.S. § 25-4-1614(3) — Cottage Foods Act: label and placard",
  statute_excerpt:
    'The following disclaimer: "This product was produced in a home kitchen that is not subject to state licensure or inspection and that may also process common food allergens such as tree nuts, peanuts, eggs, soy, wheat, milk, fish, and crustacean shellfish. This product is not intended for resale." ... A producer operating under this section shall conspicuously display a placard, sign, or card at the point of sale with the following disclaimer: "This product was produced in a home kitchen that is not subject to state licensure or inspection. This product is not intended for resale."',
  conditions: [
    "An unlabeled product is misbranded and subject to food sampling and inspection",
    "Buyers may not resell the product (C.R.S. § 25-4-1614(5))",
  ],
  effective_date: "2016-05-04",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

// Every lawful direct channel carries the full requirement set (products,
// course, cap, labeling) — an intrastate online sale with direct delivery
// needs the same permit-equivalent conditions as a farmers-market table.
const CO_COTTAGE_DIRECT_CHANNELS = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(CO_COTTAGE_DIRECT_CHANNELS, STATE, "cottage_food", cottageProducts),
  ...forChannels(CO_COTTAGE_DIRECT_CHANNELS, STATE, "cottage_food", cottageCourse),
  ...forChannels(CO_COTTAGE_DIRECT_CHANNELS, STATE, "cottage_food", cottageCap),
  ...forChannels(CO_COTTAGE_DIRECT_CHANNELS, STATE, "cottage_food", cottageLabeling),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "direct-delivery-only",
    decision: "conditional",
    summary:
      "Cottage food may be ordered online only if it is delivered directly from the producer to the informed end consumer, and only within Colorado.",
    citation_url: CRS_COTTAGE,
    citation_title: "C.R.S. § 25-4-1614(2)(d) — Cottage Foods Act: direct, in-state delivery",
    statute_excerpt:
      "The foods produced under this section must: (I) Be delivered directly from a producer to an informed end consumer; (II) Be sold only in Colorado; and (III) Not involve interstate commerce.",
    conditions: [
      "Direct producer-to-consumer delivery only — no third-party shipment or resale",
    ],
    effective_date: "2016-05-04",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Colorado cottage food may not cross state lines: the Act requires products to be sold only in Colorado and to not involve interstate commerce.",
    citation_url: CRS_COTTAGE,
    citation_title: "C.R.S. § 25-4-1614(2)(d) — Cottage Foods Act: no interstate commerce",
    statute_excerpt:
      "The foods produced under this section must: (I) Be delivered directly from a producer to an informed end consumer; (II) Be sold only in Colorado; and (III) Not involve interstate commerce.",
    conditions: [],
    effective_date: "2016-05-04",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  ...forChannels(["wholesale", "retail"], STATE, "cottage_food", {
    slug: "resale-prohibited",
    decision: "prohibited",
    summary:
      "Colorado cottage food may be sold only directly by the producer to an informed end consumer; retail stores, wholesale, and any resale are prohibited.",
    citation_url: CRS_COTTAGE,
    citation_title: "C.R.S. § 25-4-1614(2)(a), (5) — Cottage Foods Act: direct sales only",
    statute_excerpt:
      "A producer may use his or her home kitchen or a commercial, private, or public kitchen to produce foods for sale only if the producer sells the foods directly to informed end consumers. ... A person who purchases a product made by a producer shall not resell the product.",
    conditions: [],
    effective_date: "2016-05-04",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — C.R.S. § 25-5.5-117 (+ 21 CFR 1240.61 interstate)
// ---------------------------------------------------------------------------

const rawMilk: CorpusRule[] = [
  oneChannel("herdshare", STATE, "raw_milk", {
    slug: "registered-shares-only",
    decision: "conditional",
    summary:
      "Raw milk may reach consumers in Colorado only through registered cow or goat shares: acquisition under a written share contract is not a sale when the farm is registered with CDPHE, the milk carries a not-pasteurized warning, and herd-health information with test results is provided.",
    citation_url: CRS_RAW_MILK,
    citation_title: "C.R.S. § 25-5.5-117(1)–(2) — Raw milk: share acquisition and registration",
    statute_excerpt:
      "The milk is obtained pursuant to a cow share or a goat share. A cow share or a goat share is an undivided interest in a cow, goat, or herd of cows or goats, created by a written contractual relationship between a consumer and a farmer that includes a legal bill of sale to the consumer for an interest in the cow, goat, or dairy herd and a boarding contract under which the consumer boards the cow, goat, or dairy herd in which the consumer has an interest with the farmer for care and milking, and under which the consumer is entitled to receive a share of milk from the cow, goat, or dairy herd.",
    conditions: [
      "Farm or dairy registered with CDPHE: name, current address, and a statement that raw milk is produced at the farm or dairy",
      "Written share contract with a legal bill of sale for an interest in the animal or herd, plus a boarding contract for care and milking",
      "A prominent not-pasteurized warning statement delivered with the milk or on the container label",
      "Herd-health standards and test results (animals and milk) provided to the consumer, with an explanation of the tests",
      "Only share owners — or a co-owner of the same cow, goat, or herd — may receive the milk; no resale or redistribution (§ 25-5.5-117(4))",
    ],
    effective_date: "2005-04-22",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  ...forChannels(
    ["retail", "farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "raw_milk",
    {
      slug: "retail-sale-prohibited",
      decision: "prohibited",
      summary:
        "Retail sale of raw milk is illegal in Colorado — including at farmers' markets, to food establishments, and by resale. The only lawful consumer channel is a registered cow/goat share.",
      citation_url: CRS_RAW_MILK,
      citation_title: "C.R.S. § 25-5.5-117(3) — Raw milk: retail sales prohibited",
      statute_excerpt:
        "Retail sales of raw, unpasteurized milk shall not be allowed. Resale of raw milk obtained from a cow share or goat share is strictly prohibited. Raw milk that is not intended for pasteurization shall not be sold to, or offered for sale at, farmers' markets, educational institutions, health-care facilities, nursing homes, governmental organizations, or any food establishment.",
      conditions: [],
      effective_date: "2005-04-22",
      last_verified_at: VERIFIED,
      tier: "statute_verified",
    }
  ),
  oneChannel("online_interstate", STATE, "raw_milk", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Federal law prohibits delivering, selling, or distributing raw milk in final package form for direct human consumption in interstate commerce; only pasteurized milk may cross state lines (limited aged-cheese exception under 21 CFR part 133).",
    citation_url: ECFR_RAW_MILK,
    citation_title: "21 CFR 1240.61 — Mandatory pasteurization for milk in interstate commerce",
    statute_excerpt:
      "No person shall cause to be delivered into interstate commerce or shall sell, otherwise distribute, or hold for sale or other distribution after shipment in interstate commerce any milk or milk product in final package form for direct human consumption unless the product has been pasteurized or is made from dairy ingredients (milk or milk products) that have all been pasteurized, except where alternative procedures to pasteurization are provided for by regulation, such as in part 133 of this chapter for curing of certain cheese varieties.",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// eggs — C.R.S. §§ 35-21-104, 35-21-105 (+ 21 CFR 118 for interstate)
// ---------------------------------------------------------------------------

const eggSmallProducerExemption: RuleTemplate = {
  slug: "small-producer-exemption",
  decision: "conditional",
  summary:
    "A producer selling fewer than 250 dozen of their own eggs per month — only on the farm where they were produced, at a farmers' market, or through a CSA — is exempt from Colorado's egg dealer licensing; at or above that volume a CDA dealer's license is required.",
  citation_url: CRS_EGG_EXEMPTION,
  citation_title: "C.R.S. § 35-21-105(1) — Egg dealer license exemption for small producers",
  statute_excerpt:
    "a person who produces and sells only on the premises at which the poultry eggs were produced, at a farmers' market, or through a community-supported agricultural organization, less than two hundred fifty dozen poultry eggs per month is exempt from this part 1; except that such a producer may apply for a dealer's license and, if in compliance with this part 1, be issued a dealer's license.",
  conditions: [
    "Exemption covers only eggs the person produced, sold on the production premises, at a farmers' market, or through a CSA — not stores or other venues",
    "Fewer than 250 dozen poultry eggs per month; at or above that, a dealer's license under C.R.S. § 35-21-104 is required",
  ],
  effective_date: "2021-07-02",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggTransportLabel: RuleTemplate = {
  slug: "transport-labeling",
  decision: "conditional",
  summary:
    "Exempt small producers transporting eggs for farmers'-market sale must meet egg transport/refrigeration rules and label each package with the origin address, packaging date, and — unless treated for salmonella — the statutory safe-handling statement.",
  citation_url: CRS_EGG_EXEMPTION,
  citation_title: "C.R.S. § 35-21-105(2) — Small-producer transport and labeling",
  statute_excerpt:
    'Affix to the egg package a label containing the address at which the eggs originated and the date on which the eggs were packaged. Any eggs not treated for salmonella must also include the following statement on the package: "Safe Handling Instructions: To prevent illness from bacteria, keep eggs refrigerated, cook eggs until yolks are firm, and cook any foods containing eggs thoroughly. These eggs do not come from a government-approved source."',
  conditions: [
    "Comply with the transport requirements of C.R.S. § 35-21-103(3) and rules on safe transport and washing, including refrigeration",
  ],
  effective_date: "2021-07-02",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggDealerLicense: RuleTemplate = {
  slug: "dealer-license",
  decision: "conditional",
  summary:
    "Selling eggs in Colorado through stores, wholesale, online, or any venue beyond the small-producer direct venues requires a CDA dealer's license for each place of business.",
  citation_url: CRS_EGG_LICENSE,
  citation_title: "C.R.S. § 35-21-104(1) — Egg dealer's license required",
  statute_excerpt:
    "Every person selling poultry eggs or other eggs within this state shall obtain from the department a dealer's license for each place where the business is conducted. A license is not transferable.",
  conditions: [
    "One dealer's license per place of business; license categories are set by rule based on average cases (30 dozen) sold per week",
    "Producers under 250 dozen/month selling only on-farm, at farmers' markets, or through a CSA are exempt (C.R.S. § 35-21-105)",
  ],
  effective_date: "2009-07-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(["farmers_market", "on_farm"], STATE, "eggs", eggSmallProducerExemption),
  oneChannel("farmers_market", STATE, "eggs", eggTransportLabel),
  ...forChannels(
    ["retail", "wholesale", "online_intrastate", "online_interstate"],
    STATE,
    "eggs",
    eggDealerLicense
  ),
  oneChannel("online_interstate", STATE, "eggs", {
    slug: "fda-egg-rule",
    decision: "conditional",
    summary:
      "Federally, shell-egg producers with 3,000 or more laying hens who do not sell all eggs directly to consumers are covered by the FDA egg safety rule (SE prevention, testing, refrigeration, registration) when shipping in interstate commerce.",
    citation_url: ECFR_EGG_RULE,
    citation_title: "21 CFR 118.1 — Persons covered by the shell egg safety rule",
    statute_excerpt:
      "If you are a shell egg producer with 3,000 or more laying hens at a particular farm that does not sell all of your eggs directly to consumers and that produces shell eggs for the table market, you are covered by some or all of the requirements in this part",
    conditions: [
      "Farms with 3,000+ laying hens shipping interstate must register with FDA and comply with 21 CFR part 118 (Salmonella Enteritidis prevention measures, environmental and egg testing, refrigeration)",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

export const coloradoRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
