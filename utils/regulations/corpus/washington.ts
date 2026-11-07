// Wedge corpus — WASHINGTON (WA). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (statute, WAC, eCFR, or
// WSDA guidance PDF) and last verified by re-reading the source on
// 2026-11-07. Excerpts are verbatim from the cited text. Statutory and
// regulatory effective dates were filled on 2026-11-07 from the enrolled WA
// session laws (lawfilesext.leg.wa.gov) and the Federal Register documents
// (see inline notes); the two WSDA agency-guidance rows keep
// effective_date null because guidance documents carry no effective date.
// The attorney reviewer must still confirm every row before launch.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "WA";
const VERIFIED = "2026-11-07";

const RCW = "https://app.leg.wa.gov/RCW/default.aspx?cite=";
const WAC = "https://app.leg.wa.gov/WAC/default.aspx?cite=";

// ---------------------------------------------------------------------------
// cottage_food — chapter 69.22 RCW + chapter 16-149 WAC
// ---------------------------------------------------------------------------

const cottagePermit: RuleTemplate = {
  slug: "permit",
  decision: "conditional",
  summary:
    "Selling cottage food in Washington requires a WSDA cottage food operation permit, renewed every two years, with every preparer holding a Washington food worker card.",
  citation_url: `${RCW}69.22.030`,
  citation_title: "RCW 69.22.030 — Cottage food operations: permits, permit renewals",
  statute_excerpt:
    "All cottage food operations must be permitted every two years by the department on forms developed by the department. All permits and permit renewals must be made on forms developed by the director and be accompanied by an inspection fee as provided in RCW 69.22.040, a $75 public health review fee, and a $30 processing fee.",
  conditions: [
    "Current WSDA cottage food operation permit, renewed every two years ($75 public health review fee + $30 processing fee, plus the $125 basic hygiene inspection fee under RCW 69.22.040(3))",
    "Every individual involved in preparing cottage food products must hold a food and beverage service worker's permit under chapter 69.06 RCW",
    "Production only in the home kitchen of the operator's primary domestic residence (RCW 69.22.010); products must be stored only in that residence (RCW 69.22.020(5))",
  ],
  effective_date: "2023-07-23",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageCap: RuleTemplate = {
  slug: "sales-cap",
  decision: "conditional",
  summary:
    "Annual gross cottage food sales are capped at $35,000 per domestic residence; exceeding the cap requires a food processing plant license or shutting down.",
  citation_url: `${RCW}69.22.050`,
  citation_title: "RCW 69.22.050 — Cottage food operations: annual gross sales",
  statute_excerpt:
    "the annual gross sales of cottage food products may not exceed $35,000. The determination of the maximum annual gross sales must be computed on the basis of the amount of gross sales within or at a particular domestic residence and may not be computed on a per person basis within or at an individual domestic residence. ... If gross sales exceed the maximum allowable annual gross sales amount established under subsection (1) of this section, the cottage food operation must either obtain a food processing plant license under chapter 69.07 RCW or cease operations.",
  conditions: [
    "Annual gross sales of cottage food products must not exceed $35,000, computed per domestic residence (not per person)",
    "WSDA reviews the cap every four years and may raise it by expedited rulemaking tied to the Seattle-area CPI — re-verify the current cap before relying on it",
    "The director may request written documentation to verify the annual gross sales figure",
  ],
  effective_date: "2023-07-23",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageProducts: RuleTemplate = {
  slug: "allowed-products",
  decision: "conditional",
  summary:
    "Only non-potentially-hazardous products approved by WSDA and listed in the permit may be produced: baked goods, stovetop candies, and jams/jellies/preserves/fruit butters meeting 21 CFR 150. Dairy, meat, canned or pickled products, and items needing refrigeration are prohibited.",
  citation_url: `${WAC}16-149-120`,
  citation_title: "WAC 16-149-120 — Allowable cottage food products",
  statute_excerpt:
    "A cottage food operation is allowed to produce food items that are nonpotentially hazardous. ... Only those products approved by the department and listed in the permit may be produced.",
  conditions: [
    "Product must be on the WAC 16-149-120 allowable list and listed in the cottage food permit; each product variation's recipe must be submitted with the application",
    "Prohibited per WAC 16-149-130: milk and dairy products (including cheeses and yogurt), meat/poultry/fish, canned fruits/vegetables/salsas, canned pickled products (corn relish, pickles, sauerkraut), raw seed sprouts, garlic-in-oil mixtures, fresh juices, and bakery goods requiring refrigeration",
    "Jams, jellies, preserves, and fruit butters must meet 21 CFR 150 and be hot-filled or hot-water-bath processed in sterilized containers (no paraffin seals)",
  ],
  effective_date: "2016-03-21",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every cottage food product must be packaged and labeled with the business name and permit number, product name, ingredients by weight, net weight/volume, allergen labeling, and the home-kitchen disclaimer in at least 11-point contrasting type.",
  citation_url: `${RCW}69.22.020`,
  citation_title: "RCW 69.22.020 — Cottage food operations: requirements",
  statute_excerpt:
    'The following statement printed in at least the equivalent of eleven-point font size in a color that provides a clear contrast to the background: "Made in a home kitchen that has not been subject to standard inspection criteria."',
  conditions: [
    "Label must include the business name and permit number, product name, ingredients in descending order of predominance by weight, net weight or net volume, and allergen labeling as specified by WSDA rule",
    "Cottage food may not be repackaged, sold, or used as an ingredient by a food processing plant, or sold by a food service establishment (RCW 69.22.020(2))",
  ],
  effective_date: "2020-06-11",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageFood: CorpusRule[] = [
  ...forChannels(["farmers_market", "on_farm"], STATE, "cottage_food", cottagePermit),
  ...forChannels(["farmers_market", "on_farm"], STATE, "cottage_food", cottageCap),
  ...forChannels(["farmers_market", "on_farm"], STATE, "cottage_food", cottageProducts),
  ...forChannels(["farmers_market", "on_farm"], STATE, "cottage_food", cottageLabeling),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "internet-prohibited",
    decision: "prohibited",
    summary:
      "Cottage food products may not be sold by internet or mail order in Washington; WSDA confirms internet, mail, and consignment sales are prohibited — only direct sales to the end consumer.",
    citation_url: `${RCW}69.22.020`,
    citation_title: "RCW 69.22.020(4) — Cottage food operations: direct sales only",
    statute_excerpt:
      "Cottage food products may only be sold directly to the consumer and may not be sold by internet, mail order, or for retail sale outside the state.",
    conditions: [],
    effective_date: "2020-06-11",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "out-of-state-prohibited",
    decision: "prohibited",
    summary:
      "Cottage food products may not be sold for retail sale outside Washington; the operation exists only for direct-to-consumer sales from a Washington residence.",
    citation_url: `${RCW}69.22.020`,
    citation_title: "RCW 69.22.020(4) — Cottage food operations: direct sales only",
    statute_excerpt:
      "Cottage food products may only be sold directly to the consumer and may not be sold by internet, mail order, or for retail sale outside the state.",
    conditions: [],
    effective_date: "2020-06-11",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-prohibited",
    decision: "prohibited",
    summary:
      "Cottage food may not be wholesaled: it cannot be repackaged, sold, or used as an ingredient by a food processing plant, or sold by a food service establishment. Wholesaling requires a WSDA food processor license instead.",
    citation_url: `${RCW}69.22.020`,
    citation_title: "RCW 69.22.020(2) — Cottage food operations: no wholesale",
    statute_excerpt:
      "A cottage food operation must package and properly label for sale to the consumer any food it produces, and the food may not be repackaged, sold, or used as an ingredient in other foods by a food processing plant, or sold by a food service establishment.",
    conditions: [],
    effective_date: "2020-06-11",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "third-party-retail-prohibited",
    decision: "prohibited",
    summary:
      "Cottage food may be sold only directly to the consumer — not through stores, restaurants, or resellers. Selling through third parties requires a WSDA food processor license under chapter 69.07 RCW.",
    citation_url: `${RCW}69.22.010`,
    citation_title: "RCW 69.22.010(1) — Cottage food operations: definitions",
    statute_excerpt:
      '"Cottage food operation" means a person who produces cottage food products only in the home kitchen of that person\'s primary domestic residence in Washington and only for sale directly to the consumer.',
    conditions: [],
    // Current amendment: HB 1622 (2015 c 203 s 1), effective 2015-07-24 per
    // the enrolled session law.
    effective_date: "2015-07-24",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — chapter 15.36 RCW + WAC 16-101-800 + WSDA guidance + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const rawMilkLicense: RuleTemplate = {
  slug: "license",
  decision: "conditional",
  summary:
    "Selling raw milk to consumers in Washington is legal only with an annual WSDA milk processing plant license ($250/year, expires June 30) covering Grade A raw milk, plus raw-milk testing and herd-health requirements.",
  citation_url: `${RCW}15.36.051`,
  citation_title: "RCW 15.36.051 — Milk processing plant license required",
  statute_excerpt:
    "A milk processing plant must obtain an annual milk processing plant license from the department, which shall expire on June 30th of each year. ... accompanied by a two hundred fifty dollar annual license fee beginning July 1, 2015.",
  conditions: [
    "Annual WSDA milk processing plant license ($250) with the raw-milk product endorsement; licenses cover only the products, processes, and operations specified in the approved application",
    "Grade A raw milk must meet PMO-based requirements adopted by rule under RCW 15.36.021(3), including bacterial and animal-health testing",
    "WSDA: retail raw milk must be produced and processed at the same site, and cannot be used to make other foods (yogurt, butter, ice cream) — see WSDA Retail Raw Milk guide",
  ],
  // Current amendment: ESHB 2128 (2015 3rd sp.s. c 27 s 2), effective
  // 2015-10-09 per the enrolled session law.
  effective_date: "2015-10-09",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilkLabel: RuleTemplate = {
  slug: "warning-label",
  decision: "conditional",
  summary:
    "Every raw milk container sold to consumers in Washington must bear the statutory warning label in contrasting color on the principal display panel.",
  citation_url: `${WAC}16-101-800`,
  citation_title: "WAC 16-101-800 — Raw milk warning labels",
  statute_excerpt:
    "A raw milk container must bear the following labeling: WARNING: This product has not been pasteurized and may contain harmful bacteria. Pregnant women, children, the elderly and persons with lowered resistance to disease have the highest risk of harm from use of this product.",
  conditions: [
    "Warning type size at least 1/16 inch, conspicuous, contrasting color, clearly readable, prominently displayed on the principal display panel",
  ],
  effective_date: "2019-05-06",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilkRetailGuidance: RuleTemplate = {
  slug: "retail-scope",
  decision: "conditional",
  summary:
    "WSDA licenses retail raw milk producer-processors; retail raw milk covers fluid whole milk and hand-skimmed cream only — no separator or homogenizer, no flavored or cultured fluid milk.",
  citation_url: "https://cms.agr.wa.gov/WSDAKentico/Documents//311-RetailRawMilkGuide.pdf",
  citation_title: "WSDA — Retail Raw Milk: A Quick Guide for Producer-Processors",
  statute_excerpt:
    "Retail Raw Milk includes fluid whole milk, hand-skimmed cream and milk which has been hand-skimmed. This means a plant cannot use a separator, homogenizer or any other mechanical device to separate raw cream from raw milk. Retail Raw Milk does not include chocolate or flavored milk, or cultured fluid milk (buttermilk).",
  conditions: [
    "Retail raw milk must be produced and processed at the same site; it may go to a wholesale distributor only after being packaged for the retail consumer",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const RAW_MILK_DIRECT_CHANNELS = [
  "retail",
  "on_farm",
  "farmers_market",
  "online_intrastate",
  "wholesale",
];

const rawMilk: CorpusRule[] = [
  ...forChannels(RAW_MILK_DIRECT_CHANNELS, STATE, "raw_milk", rawMilkLicense),
  ...forChannels(RAW_MILK_DIRECT_CHANNELS, STATE, "raw_milk", rawMilkLabel),
  oneChannel("retail", STATE, "raw_milk", rawMilkRetailGuidance),
  oneChannel("herdshare", STATE, "raw_milk", {
    slug: "share-is-a-sale",
    decision: "conditional",
    summary:
      "WSDA treats cow/farm shares as a sale of milk: a share arrangement is lawful only when the producer holds the required WSDA licenses — a share agreement cannot be used to avoid licensing.",
    citation_url: "https://cms.agr.wa.gov/WSDAKentico/Imported//518-RawMilkTruth.pdf",
    citation_title: "WSDA — The Truth About Raw Milk Sales",
    statute_excerpt:
      "A Cow Share agreement is legal in Washington as long as the producer is properly licensed with the Washington State Department of Agriculture. A Cow Share may not be used as a means to avoid meeting state requirements for milk producers and milk processors, including obtaining the required license.",
    conditions: [
      "Producer must hold the WSDA milk processing plant license for raw milk distributed via shares ($250/year)",
      '"Sale" is defined broadly in RCW 15.36.012 to include selling, offering for sale, distributing, delivering, supplying, trading, and bartering',
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_interstate", STATE, "raw_milk", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Federal law prohibits delivering, selling, or distributing raw milk in final package form for direct human consumption in interstate commerce; only pasteurized milk may cross state lines (limited aged-cheese exception under 21 CFR part 133).",
    citation_url:
      "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61",
    citation_title: "21 CFR 1240.61 — Mandatory pasteurization for milk in interstate commerce",
    statute_excerpt:
      "No person shall cause to be delivered into interstate commerce or shall sell, otherwise distribute, or hold for sale or other distribution after shipment in interstate commerce any milk or milk product in final package form for direct human consumption unless the product has been pasteurized or is made from dairy ingredients (milk or milk products) that have all been pasteurized, except where alternative procedures to pasteurization are provided for by regulation, such as in part 133 of this chapter for curing of certain cheese varieties.",
    conditions: [],
    // Final rule, Docket 81N-204C (52 FR 29509): effective 1987-09-09 per the
    // Federal Register document.
    effective_date: "1987-09-09",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// eggs — chapter 69.25 RCW (+ 21 CFR 118 for interstate)
// ---------------------------------------------------------------------------

const eggLicense: RuleTemplate = {
  slug: "handler-license",
  decision: "conditional",
  summary:
    "Acting as an egg handler or dealer in Washington — including a producer selling their own eggs at retail — requires an annual WSDA egg handler/dealer license ($30) and a permanent dealer number.",
  citation_url: `${RCW}69.25.050`,
  citation_title: "RCW 69.25.050 — Egg handler's or dealer's license required",
  statute_excerpt:
    "No person may act as an egg handler or dealer without first obtaining an annual license and permanent dealer's number from the department. ... The annual egg dealer license fee is thirty dollars and the annual egg dealer branch license fee is fifteen dollars.",
  conditions: [
    "Annual egg handler/dealer license through the state business licensing system ($30; $15 per branch location)",
    "License and permanent dealer number are nontransferable; the business license must be posted at each operating location",
    "Eggs sold for human food must meet the WAC 16-104 shell-egg standards, grades, and weight classes",
  ],
  effective_date: "2013-07-28",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "retail", "wholesale", "online_intrastate"],
    STATE,
    "eggs",
    eggLicense
  ),
  ...forChannels(["online_interstate"], STATE, "eggs", eggLicense),
  oneChannel("online_interstate", STATE, "eggs", {
    slug: "fda-egg-rule",
    decision: "conditional",
    summary:
      "Federally, shell-egg producers with 3,000 or more laying hens who do not sell all eggs directly to consumers are covered by the FDA egg safety rule (SE prevention, testing, refrigeration, registration) when shipping in interstate commerce.",
    citation_url:
      "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1",
    citation_title: "21 CFR 118.1 — Persons covered by the shell egg safety rule",
    statute_excerpt:
      "If you are a shell egg producer with 3,000 or more laying hens at a particular farm that does not sell all of your eggs directly to consumers and that produces shell eggs for the table market, you are covered by some or all of the requirements in this part",
    conditions: [
      "Farms with 3,000+ laying hens shipping interstate must register with FDA and comply with 21 CFR part 118 (Salmonella Enteritidis prevention measures, environmental and egg testing, refrigeration)",
    ],
    // Final rule (74 FR 33030, published 2009-07-09): effective 2009-09-08 per
    // the Federal Register document (compliance for 3,000+ hen producers was
    // 2010-07-09).
    effective_date: "2009-09-08",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

export const washingtonRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
