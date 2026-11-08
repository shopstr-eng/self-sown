// Wedge corpus — OHIO (OH). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (Ohio Revised Code and
// Ohio Administrative Code on codes.ohio.gov, ODA cottage-food guidance,
// eCFR) and last verified by re-reading the source on 2026-11-08. Excerpts
// are verbatim from the cited text. Effective dates come from the codes.
// ohio.gov version metadata where shown; the attorney reviewer must confirm
// every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "OH";
const VERIFIED = "2026-11-08";

const ORC_3715_01 = "https://codes.ohio.gov/ohio-revised-code/section-3715.01";
const ORC_3715_023 = "https://codes.ohio.gov/ohio-revised-code/section-3715.023";
const OAC_COTTAGE =
  "https://codes.ohio.gov/ohio-administrative-code/rule-901:3-20-04";
const ODA_COTTAGE =
  "https://agri.ohio.gov/divisions/food-safety/resources/cottage-food";
const ORC_917_04 = "https://codes.ohio.gov/ohio-revised-code/section-917.04";
const ORC_3715_021 = "https://codes.ohio.gov/ohio-revised-code/section-3715.021";
const ORC_925_01 = "https://codes.ohio.gov/ohio-revised-code/section-925.01";
const ORC_925_021 = "https://codes.ohio.gov/ohio-revised-code/section-925.021";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — ORC 3715.01(A)(19) + 3715.023 + OAC 901:3-20-04
// ---------------------------------------------------------------------------

const cottageDefinition: RuleTemplate = {
  slug: "license-exemption",
  decision: "conditional",
  summary:
    "Ohio cottage food production operations — people producing non-potentially-hazardous foods in their home — are exempt from ODA licensing and inspection; no registration or sales cap applies.",
  citation_url: ORC_3715_01,
  citation_title: "ORC 3715.01(A)(19) — Cottage food production operation defined",
  statute_excerpt:
    "\"Cottage food production operation\" means a person who, in the person's home, produces food items that are not potentially hazardous foods, including bakery products, jams, jellies, candy, fruit butter, and similar products specified in rules adopted pursuant to section 3715.025 of the Revised Code.",
  conditions: [
    "Production must occur in the person's home (primary residence with a single residential stove or oven, per ODA guidance)",
    "Only non-potentially-hazardous foods on the OAC 901:3-20-04 approved list; reduced oxygen packaging is prohibited",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageProducts: RuleTemplate = {
  slug: "allowed-products",
  decision: "conditional",
  summary:
    "Ohio's approved cottage food list covers non-potentially-hazardous bakery products, jams, jellies, candy, flavored honey, fruit chutneys and butters, granola, popcorn, dry mixes, roasted coffee, dry herbs, seasonings, and tea blends — and nothing requiring temperature control.",
  citation_url: OAC_COTTAGE,
  citation_title: "OAC 901:3-20-04 — Cottage food products allowed",
  statute_excerpt:
    "(A) The food items listed below are approved as cottage food products: (1) Non-potentially hazardous bakery products; (2) Jams; (3) Jellies; (4) Candy, not including fresh fruit dipped, covered, or otherwise incorporated with candy; ... (20) Dry tea blends. (B) Cottage food products may not be packed using reduced oxygen packaging.",
  conditions: [
    "Products not on the approved list (e.g. fresh-fruit-dipped candy, popping corn) are not cottage foods and need full licensing",
  ],
  effective_date: "2016-01-22",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every Ohio cottage food product must be labeled with the business name and address, product name, ingredients in descending order by weight, net weight and volume, and the ten-point statement \"This product is home produced.\"",
  citation_url: ORC_3715_023,
  citation_title:
    "ORC 3715.023 — Labels for cottage food production operation, processor, or beekeeper",
  statute_excerpt:
    "A cottage food production operation and a maple syrup or sorghum processor and beekeeper described in division (A) of section 3715.021 of the Revised Code shall label each of their food products and include the following information on the label of each of their food products: (1) The name and address of the business of the cottage food production operation, processor, or beekeeper; (2) The name of the food product; (3) The ingredients of the food product, in descending order of predominance by weight; (4) The net weight and volume of the food product; (5) In the case of a cottage food production operation, the following statement in ten-point type: \"This product is home produced.\"",
  conditions: [
    "Unlabeled or mislabeled cottage foods are misbranded/adulterated under ORC chapter 3715",
  ],
  effective_date: "2001-11-21",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];
// The product list and statutory label apply to EVERY lawful cottage food
// channel — a grocery-store sale carries the same requirements as a
// farmers-market table — so they are stamped onto retail/wholesale too.
const cottageAllChannels = [...cottageDirectChannels, "retail", "wholesale"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageAllChannels, STATE, "cottage_food", cottageDefinition),
  ...forChannels(cottageAllChannels, STATE, "cottage_food", cottageProducts),
  ...forChannels(cottageAllChannels, STATE, "cottage_food", cottageLabeling),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "retail-grocery-restaurant-allowed",
    decision: "conditional",
    summary:
      "Ohio cottage foods that are properly identified and labeled may be sold through grocery stores and even used in preparing food in a restaurant — unusually broad retail access — but only within Ohio.",
    citation_url: ODA_COTTAGE,
    citation_title: "ODA — Cottage Food Production Operation",
    statute_excerpt:
      "Cottage Food Products may only be sold in Ohio. Cottage Food Products that are properly identified and labeled may be sold directly to the consumer from the home where the products are produced. They may also be sold through grocery stores, registered farm markets, farmers markets, and sold and/or used in preparing food in a restaurant.",
    conditions: [
      "Sales at festivals or celebrations only when organized by a political subdivision of the state and lasting no longer than seven consecutive days",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-in-state-only",
    decision: "conditional",
    summary:
      "Ohio cottage foods may flow through grocery stores and registered farm markets (wholesale-style distribution) as long as they are properly identified and labeled and remain in Ohio.",
    citation_url: ODA_COTTAGE,
    citation_title: "ODA — Cottage Food Production Operation",
    statute_excerpt:
      "They may also be sold through grocery stores, registered farm markets, farmers markets, and sold and/or used in preparing food in a restaurant.",
    conditions: [
      "Distribution must remain within Ohio; products must carry the full ORC 3715.023 label",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "in-state-only",
    decision: "conditional",
    summary:
      "Ohio allows in-state cottage food sales broadly (home, markets, grocery stores) but ODA restricts cottage food products to sales within Ohio, so internet sales must stay in-state.",
    citation_url: ODA_COTTAGE,
    citation_title: "ODA — Cottage Food Production Operation",
    statute_excerpt:
      "Cottage Food Products may only be sold in Ohio.",
    conditions: [
      "ORC 3715.023 labeling and the OAC 901:3-20-04 product list still apply",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "ODA's cottage food guidance limits cottage food products to sales within Ohio; interstate mail-order sales are outside the exemption.",
    citation_url: ODA_COTTAGE,
    citation_title: "ODA — Cottage Food Production Operation",
    statute_excerpt: "Cottage Food Products may only be sold in Ohio.",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — ORC 917.04 (retail sales prohibited; pre-1965 grandfather) +
// 21 CFR 1240.61 (interstate)
// ---------------------------------------------------------------------------

const rawMilkProhibited: RuleTemplate = {
  slug: "sale-prohibited",
  decision: "prohibited",
  summary:
    "Ohio prohibits raw milk sales to the ultimate consumer; the only exception is a continuously operating retailer licensed since before October 31, 1965 — a grandfather no new producer can qualify for.",
  citation_url: ORC_917_04,
  citation_title: "ORC 917.04 — Sales of and labeling for raw milk",
  statute_excerpt:
    "No raw milk retailer shall sell, offer for sale, or expose for sale raw milk to the ultimate consumer except a raw milk retailer who, prior to October 31, 1965, was engaged continuously in the business of selling or offering for sale raw milk directly to ultimate consumers, holds a valid raw milk retailer license issued under section 917.09 of the Revised Code, and is subject to the rules regulating the sale of raw milk adopted under this chapter.",
  conditions: [],
  effective_date: "1997-10-21",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  ...forChannels(
    ["on_farm", "farmers_market", "retail", "wholesale", "online_intrastate"],
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
// eggs — ORC 3715.021(A)(2) (small egg producer ≤500 birds) + 925.01(C) +
// 925.021 (container labels)
// ---------------------------------------------------------------------------

const eggSmallProducer: RuleTemplate = {
  slug: "small-egg-producer-exemption",
  decision: "conditional",
  summary:
    "Ohio's 'small egg producer' — anyone maintaining 500 or fewer birds annually — is excluded from food processing establishment licensing, and only producers maintaining more than 500 birds fall under the shell-egg marketing chapter's producer rules.",
  citation_url: ORC_3715_021,
  citation_title: "ORC 3715.021(A)(2) — Small egg producer defined",
  statute_excerpt:
    "\"Small egg producer\" means any person that is engaged in the operation of egg production and annually maintains five hundred or fewer birds.",
  conditions: [
    "500 or fewer birds maintained annually; above that, the producer is a 'producer' under ORC 925.01(C) subject to the shell-egg marketing chapter",
    "Container labeling under ORC 925.021 still applies to all sellers",
  ],
  effective_date: "2025-09-30",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggLabeling: RuleTemplate = {
  slug: "container-labeling",
  decision: "conditional",
  summary:
    "Every seller of shell eggs in Ohio must label containers with the packer or distributor's name and address, quantity, processing date, and grade and size — ungraded eggs must be labeled 'ungraded' or 'unclassified' and may use 'mixed size' if averaging 21 ounces or more per dozen.",
  citation_url: ORC_925_021,
  citation_title: "ORC 925.021 — Egg container labels",
  statute_excerpt:
    "No person shall sell, offer for sale, or expose for sale shell eggs in a container which is not labeled with: (1) The name and address of the packer or distributor; (2) An accurate statement of the quantity of the contents in terms of numerical count; (3) The date the shell eggs were processed; (4) The correct grade and size or weight class of the contents thereof in accordance with the standards adopted by this state, provided that containers of shell eggs which have not been graded for quality or which fail to meet the requirements of a grade adopted by this state: (a) Shall be labeled \"ungraded\" or \"unclassified\"; (b) May be labeled \"mixed size\" in lieu of a standard size or weight class adopted by this state, if the eggs average twenty-one ounces or more per dozen.",
  conditions: [],
  effective_date: "1992-10-06",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggProducerRules: RuleTemplate = {
  slug: "producer-over-500-birds",
  decision: "conditional",
  summary:
    "Producers maintaining more than 500 birds annually are regulated 'producers' under ORC chapter 925 and must follow the shell-egg standards, grades, and weight classes adopted from USDA.",
  citation_url: ORC_925_01,
  citation_title: "ORC 925.01(C) — Producer defined",
  statute_excerpt:
    "\"Producer\" means any person engaged in the operation of egg production who maintains annually more than five hundred birds.",
  conditions: [
    "USDA-adopted standards, grades, and weight classes apply (ORC 925.02); container labeling under ORC 925.021 applies to all sellers",
  ],
  effective_date: "1994-06-20",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggSmallProducer
  ),
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggLabeling
  ),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggLabeling),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggProducerRules),
  oneChannel("online_interstate", STATE, "eggs", eggProducerRules),
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

export const ohioRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
