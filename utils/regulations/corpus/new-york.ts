// Wedge corpus — NEW YORK (NY). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (NY Dept. of
// Agriculture & Markets program pages reproducing 1 NYCRR Part 2 and the
// shell-egg labeling rules, eCFR) and last verified by re-reading the source
// on 2026-11-08. Excerpts are verbatim from the cited text. NY cottage food
// has no standalone statute — the Home Processor Exemption from Article 20-C
// licensing is administered by Ag & Markets guidance — so those rows are tier
// agency_guidance (same posture as Idaho). Effective dates are null pending
// session-law verification; the attorney reviewer must confirm every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "NY";
const VERIFIED = "2026-11-08";

const NY_HOME_PROCESSOR = "https://agriculture.ny.gov/food-safety/home-processing";
const NY_RAW_MILK = "https://agriculture.ny.gov/raw-milk-sales-regulations";
const NY_EGGS =
  "https://agriculture.ny.gov/system/files/documents/2026/05/shelleggs_regulationsandlabelingrequirements.pdf";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — Home Processor Exemption from Article 20-C licensing
// (Ag & Markets guidance)
// ---------------------------------------------------------------------------

const cottageExemption: RuleTemplate = {
  slug: "home-processor-exemption",
  decision: "conditional",
  summary:
    "New York's Home Processor Exemption lets a home kitchen prepare qualifying low-risk foods without an Article 20-C food processing establishment license, once the operation registers with the Department of Agriculture and Markets.",
  citation_url: NY_HOME_PROCESSOR,
  citation_title: "NYS Department of Agriculture & Markets — Home Processing",
  statute_excerpt:
    "If you plan to make foods such as certain baked goods, jellies, or snack mixes, you may qualify for a Home Processor Exemption. This will allow you to prepare food in your home kitchen for wholesale or retail sale at agricultural farm venues. You will be exempt from Article 20-C licensing.",
  conditions: [
    "Operation must register with Ag & Markets as a home processor before selling",
    "Foods must be on the Department's allowed list (non-potentially-hazardous: baked goods, jams, jellies, snack mixes, etc.); prohibited items include perishable/canned low-acid foods",
    "Private-well operations must submit certified-lab potability results (Total Coliform and E. Coli negative/absent) with the application",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every New York home-processor product must be pre-packaged in the home and labeled with the product name, ingredient list in predominance by weight, net quantity, processor name and full address, allergen identification, and a home-kitchen statement.",
  citation_url: NY_HOME_PROCESSOR,
  citation_title: "NYS Department of Agriculture & Markets — Home Processing",
  statute_excerpt:
    "Product labels are required to contain the following information: common/usual name of the product, ingredient list in predominance by weight, net quantity of contents, processor name, and full address. ... Home processors should add a phrase like “Made at Home by XYZ,” or “Made in the Home Kitchen of XYZ,” or “Made in a Home Kitchen,” to their label",
  conditions: [
    "All allergens (eggs, milk, fish, shellfish, soybeans, peanuts, tree nuts, wheat, and sesame) must be clearly identified in the ingredient statement",
    "Packaging of food items at an agricultural event (craft fair, farmers' market, etc.) is not permitted — products must arrive pre-packaged",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageExemption),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageLabeling),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "internet-and-delivery-allowed",
    decision: "conditional",
    summary:
      "New York home processors may market products wholesale and/or retail, including farm venues, home delivery, and the internet — but every item must be sold within New York State.",
    citation_url: NY_HOME_PROCESSOR,
    citation_title: "NYS Department of Agriculture & Markets — Home Processing",
    statute_excerpt:
      "All items are for marketing products at wholesale and/or retail, including agricultural venues such as farms, farm stands, farmers markets, green markets, craft fairs and flea markets, via home delivery, or via the internet. All items must be sold within New York State and must be pre-packaged in the home and properly labeled.",
    conditions: [
      "Sale and delivery must stay within New York State",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "New York home-processor products may be sold only within New York State; interstate mail-order sales are outside the exemption.",
    citation_url: NY_HOME_PROCESSOR,
    citation_title: "NYS Department of Agriculture & Markets — Home Processing",
    statute_excerpt:
      "All items must be sold within New York State and must be pre-packaged in the home and properly labeled.",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "retail-allowed",
    decision: "conditional",
    summary:
      "New York home-processor products may be sold at retail (including through retail establishments), provided the operation is registered, the foods are on the allowed list, and all labeling rules are met.",
    citation_url: NY_HOME_PROCESSOR,
    citation_title: "NYS Department of Agriculture & Markets — Home Processing",
    statute_excerpt:
      "All items are for marketing products at wholesale and/or retail, including agricultural venues such as farms, farm stands, farmers markets, green markets, craft fairs and flea markets, via home delivery, or via the internet.",
    conditions: [
      "Registration, allowed-products, and labeling conditions all still apply",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-allowed",
    decision: "conditional",
    summary:
      "New York expressly contemplates wholesale marketing by registered home processors — unusual among cottage-food frameworks — subject to the same registration, product-list, and labeling conditions.",
    citation_url: NY_HOME_PROCESSOR,
    citation_title: "NYS Department of Agriculture & Markets — Home Processing",
    statute_excerpt:
      "All items are for marketing products at wholesale and/or retail, including agricultural venues such as farms, farm stands, farmers markets, green markets, craft fairs and flea markets, via home delivery, or via the internet.",
    conditions: [
      "Registration, allowed-products, and labeling conditions all still apply",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — 1 NYCRR 2.3(b) (Permit to Sell Raw Milk) + 21 CFR 1240.61
// ---------------------------------------------------------------------------

const rawMilkPermit: RuleTemplate = {
  slug: "on-farm-permit",
  decision: "conditional",
  summary:
    "New York raw milk sales require a permit to sell raw milk issued by the commissioner, and even a permit holder may sell only directly to the consumer, on the dairy farm where the milk is produced, with the statutory warning sign posted at the point of sale.",
  citation_url: NY_RAW_MILK,
  citation_title: "1 NYCRR 2.3(b) — Permit to Sell Raw Milk",
  statute_excerpt:
    "Every person who sells, offers for sale or otherwise makes available raw milk for consumption by consumers shall hold a permit to sell raw milk issued by the commissioner. A person who holds a permit to sell raw milk may sell, offer for sale or otherwise make available raw milk only: (i) directly to a consumer; (ii) on the dairy farm where such raw milk is produced; (iii) in a bottle or in a single service container mechanically filled and capped as set forth in this Part or in a container provided by the consumer filled in his presence; and (iv) if at the point of sale a sign is conspicuously posted, easily capable of being read, from such point, stating: \"NOTICE: Raw milk sold here. Raw milk does not provide the protection of pasteurization.\"",
  conditions: [
    "Permit to sell raw milk issued by the commissioner (1 NYCRR Part 2)",
    "On-farm, direct-to-consumer sales only — no delivery, off-farm, retail-store, or farmers-market sales are authorized",
    "The dairy farm must remain in substantial compliance with the Grade A prepasteurized production requirements of 1 NYCRR Part 2, including sampling and quality standards",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilkNotAuthorized: RuleTemplate = {
  slug: "channel-not-authorized",
  decision: "prohibited",
  summary:
    "New York's raw milk permit authorizes only on-farm, direct-to-consumer sales; sales through this channel are not authorized by 1 NYCRR 2.3(b).",
  citation_url: NY_RAW_MILK,
  citation_title: "1 NYCRR 2.3(b) — Permit to Sell Raw Milk",
  statute_excerpt:
    "A person who holds a permit to sell raw milk may sell, offer for sale or otherwise make available raw milk only: (i) directly to a consumer; (ii) on the dairy farm where such raw milk is produced",
  conditions: [],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  oneChannel("on_farm", STATE, "raw_milk", rawMilkPermit),
  ...forChannels(
    ["farmers_market", "retail", "wholesale", "online_intrastate"],
    STATE,
    "raw_milk",
    rawMilkNotAuthorized
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
// eggs — Ag & Markets shell-egg labeling rules (producer-direct exemption)
// ---------------------------------------------------------------------------

const eggProducerDirect: RuleTemplate = {
  slug: "producer-direct-exemption",
  decision: "conditional",
  summary:
    "A New York producer selling eggs of their own production directly to consumers is exempt from grade and size labeling requirements, though the eggs must still be of Grade B or better quality, refrigerated at 45°F or below, and carry the basic carton labeling.",
  citation_url: NY_EGGS,
  citation_title:
    "NYS Ag & Markets — Shell Eggs: Regulations and Labeling Requirements",
  statute_excerpt:
    "A producer selling eggs of his own production directly to consumers is exempt from Grade and Size labeling requirements. These eggs must, however, be graded and be of Grade B or better quality.",
  conditions: [
    "Only eggs of the producer's own production, sold directly to consumers",
    "All eggs must be refrigerated and held at 45°F or below immediately after packing, during transportation, and at retail",
    "Leakers, blood spots, meat spots and other loss-type eggs may not be sold for human consumption",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggLabeling: RuleTemplate = {
  slug: "labeling-and-refrigeration",
  decision: "conditional",
  summary:
    "Shell eggs sold in New York must be labeled with the statement of identity, grade, size, count, packer name/address/zip or packer identification number, a keep-refrigerated statement, and safe-handling instructions, and held at 45°F or below.",
  citation_url: NY_EGGS,
  citation_title:
    "NYS Ag & Markets — Shell Eggs: Regulations and Labeling Requirements",
  statute_excerpt:
    "All eggs must be refrigerated and held at 45ºF or below immediately after packing, during transportation and at retail.",
  conditions: [
    "Carton must show “EGGS”, GRADE and SIZE (3/8-inch letters or larger), count, and name/address/zip or packer identification number",
    "Carton must carry “KEEP REFRIGERATED” and the safe-handling statement",
    "Producer-direct sales to consumers are exempt from the grade and size labeling only (Grade B or better quality still required)",
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
    eggProducerDirect
  ),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggLabeling),
  oneChannel("online_interstate", STATE, "eggs", eggLabeling),
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

export const newYorkRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
