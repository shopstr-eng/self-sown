// Wedge corpus — IDAHO (ID). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (Idaho Statutes on
// legislature.idaho.gov, IDAPA rules PDF, ISDA and Central District Health
// guidance, eCFR) and last verified by re-reading the source on 2026-11-07.
// Excerpts are verbatim from the cited text. Idaho cottage food has no
// statute — the framework is health-district guidance under the Idaho Food
// Code — so those rows are tier agency_guidance. Effective dates are null
// pending session-law verification; the attorney reviewer must confirm
// every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "ID";
const VERIFIED = "2026-11-07";

const CDH_FAQ =
  "https://cdh.idaho.gov/wp-content/uploads/2023/10/Cottage-Foods-FAQ.pdf";
const IDAPA_RAW_MILK =
  "https://files.dfm.idaho.gov/dfm-admin-website/rules/current/02/020413.pdf";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — no state statute; Central District Health FAQ under the
// Idaho Food Code (agency guidance)
// ---------------------------------------------------------------------------

const cottageNoPermit: RuleTemplate = {
  slug: "no-permit-required",
  decision: "conditional",
  summary:
    "Idaho requires no food establishment permit for cottage food sold directly to consumers; there is no state sales cap. Venues may still require a completed Cottage Foods Risk Assessment Form reviewed by the local Public Health District.",
  citation_url: CDH_FAQ,
  citation_title: "Central District Health — Cottage Foods FAQ",
  statute_excerpt:
    "Although you are not required by Idaho law to secure a food establishment permit from your PHD, a venue has the right to establish its own rules and policies that require you to demonstrate that you have consulted with the PHD.",
  conditions: [
    "Foods must be non-time/temperature-control-for-safety (non-TCS): baked goods, jams, jellies, honey, and similar shelf-stable products",
    "Low-acid canned foods, acidified (pickled) products, and dehydrated vegetables are excluded",
    "A farmers market or other venue may require a Cottage Foods Risk Assessment Form reviewed by the local Public Health District",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageNoPermit),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "internet-direct-allowed",
    decision: "conditional",
    summary:
      "Internet and mail-order cottage food sales are allowed in Idaho as long as the sale is directly to the consumer — online advertising and ordering are expressly permitted.",
    citation_url: CDH_FAQ,
    citation_title: "Central District Health — Cottage Foods FAQ",
    statute_excerpt:
      "As long as you are selling only directly to a consumer, yes.",
    conditions: [
      "Sale must be directly to the end consumer — no third-party fulfillment or resale",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-destination-law",
    decision: "conditional",
    summary:
      "Idaho guidance allows direct-to-consumer internet and mail-order sales without an in-state restriction; the destination state's cottage food law governs whether an interstate shipment is lawful there.",
    citation_url: CDH_FAQ,
    citation_title: "Central District Health — Cottage Foods FAQ",
    statute_excerpt:
      "As long as you are selling only directly to a consumer, yes.",
    conditions: [
      "Confirm the destination state's cottage food law before shipping across state lines",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "third-party-prohibited",
    decision: "prohibited",
    summary:
      "Cottage food may not be sold through stores or any third party in Idaho; distributing via wholesale or consignment makes the operation a regulated food establishment subject to full Idaho Food Code requirements.",
    citation_url: CDH_FAQ,
    citation_title: "Central District Health — Cottage Foods FAQ",
    statute_excerpt:
      "No, if you intend to distribute the product to any third party (wholesale, consignment), you are a regulated food establishment and must meet all the requirements of IDAHO FOOD CODE regulations.",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-prohibited",
    decision: "prohibited",
    summary:
      "Wholesale and consignment distribution of cottage food is prohibited; any third-party distribution requires full Idaho Food Code food-establishment compliance.",
    citation_url: CDH_FAQ,
    citation_title: "Central District Health — Cottage Foods FAQ",
    statute_excerpt:
      "No, if you intend to distribute the product to any third party (wholesale, consignment), you are a regulated food establishment and must meet all the requirements of IDAHO FOOD CODE regulations.",
    conditions: [],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — Idaho Code 37-1101 (herdshares) + IDAPA 02.04.13 (raw milk
// permits) + 21 CFR 1240.61 (interstate)
// ---------------------------------------------------------------------------

const rawMilkPermit: RuleTemplate = {
  slug: "raw-milk-permit",
  decision: "conditional",
  summary:
    "Selling raw milk in Idaho requires a valid ISDA raw milk permit (or herd-share registration); permitted raw milk may be sold only at locations within Idaho, never through restaurants or food-service establishments, and animals must pass annual brucellosis and tuberculosis testing.",
  citation_url: IDAPA_RAW_MILK,
  citation_title: "IDAPA 02.04.13 — Rules Governing Raw Milk",
  statute_excerpt:
    "The sale of raw milk and raw milk products, produced under the authority of these rules, is limited only to locations within the state of Idaho. ... Raw milk or raw milk products may not be sold or offered for sale through restaurants or other food service establishments.",
  conditions: [
    "Valid raw milk permit from the Idaho State Department of Agriculture (or herd-share registration)",
    "All raw milk must be from animals with a negative brucellosis test within the last 12 months and accredited tuberculosis-free or TB-tested within the last 12 months",
    "Sales limited to locations within Idaho; no sales through restaurants or food service establishments",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  ...forChannels(
    ["on_farm", "farmers_market", "online_intrastate"],
    STATE,
    "raw_milk",
    rawMilkPermit
  ),
  oneChannel("retail", STATE, "raw_milk", {
    slug: "retail-authorized-facilities",
    decision: "conditional",
    summary:
      "Grocery stores and similar retail establishments may sell raw milk in Idaho without their own raw-milk permit, provided they receive it from ISDA-authorized (permitted) facilities.",
    citation_url: IDAPA_RAW_MILK,
    citation_title: "IDAPA 02.04.13 — Rules Governing Raw Milk",
    statute_excerpt:
      "Grocery stores and similar establishments where raw milk or raw milk products are sold at retail, but not processed there, are exempt from the requirements of these rules, provided those stores and establishments receive raw milk or raw milk products from Department-authorized facilities.",
    conditions: [
      "Producer must hold the ISDA raw milk permit; the retailer is exempt only when receiving from Department-authorized facilities",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "raw_milk", rawMilkPermit),
  oneChannel("herdshare", STATE, "raw_milk", {
    slug: "herdshare-legal",
    decision: "conditional",
    summary:
      "Idaho expressly legalizes cow, sheep, and goat shares: acquiring raw milk as a share owner is not a sale, but the share owner must pick up the milk directly from the farm and the farm or dairy must be registered.",
    citation_url:
      "https://legislature.idaho.gov/statutesrules/idstat/title37/t37ch11/sect37-1101/",
    citation_title:
      "Idaho Code 37-1101 — Acquisition of raw milk or raw milk products by owner of cow, sheep, or goat share",
    statute_excerpt:
      "The acquisition of raw milk or raw milk products from cows, sheep, or goats by an owner of a cow share, sheep share, or goat share for use or consumption by the owner or members of the owner's household shall not constitute the sale or retail sale of raw milk or raw milk products and shall not be prohibited. The owner of a cow share, sheep share, or goat share shall receive raw milk or raw milk products directly from the farm or dairy where the cow, sheep, goat, or dairy herd is located. Such farm or dairy shall be registered.",
    conditions: [
      "Written contractual share agreement; a herd share is an undivided ownership interest in no more than 7 cows, 15 goats, or 15 sheep (IDAPA 02.04.13)",
      "Share owner must receive the milk directly from the farm or dairy; the farm must be registered with ISDA",
      "Herd-share animals must meet the IDAPA brucellosis/tuberculosis testing requirements",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "raw_milk", {
    slug: "interstate-prohibited",
    decision: "prohibited",
    summary:
      "Federal law prohibits delivering, selling, or distributing raw milk in final package form for direct human consumption in interstate commerce; Idaho rules additionally limit permitted raw-milk sales to locations within Idaho.",
    citation_url: CFR_RAW_MILK,
    citation_title:
      "21 CFR 1240.61 — Mandatory pasteurization for milk in interstate commerce",
    statute_excerpt:
      "No person shall cause to be delivered into interstate commerce or shall sell, otherwise distribute, or hold for sale or other distribution after shipment in interstate commerce any milk or milk product in final package form for direct human consumption unless the product has been pasteurized or is made from dairy ingredients (milk or milk products) that have all been pasteurized, except where alternative procedures to pasteurization are provided for by regulation, such as in part 133 of this chapter for curing of certain cheese varieties.",
    conditions: [
      "IDAPA 02.04.13 independently limits permitted raw-milk sales to locations within the state of Idaho",
    ],
    effective_date: "1987-09-09",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
];

// ---------------------------------------------------------------------------
// eggs — ISDA egg candler/distributor rules (small-flock exemption)
// ---------------------------------------------------------------------------

const eggSmallFlock: RuleTemplate = {
  slug: "small-flock-exemption",
  decision: "conditional",
  summary:
    "Producers with fewer than 300 birds may sell eggs in Idaho without a candler/distributor license, provided the eggs are clean and each container is labeled with the producer's name, address, phone number, and the words 'UNGRADED EGGS.'",
  citation_url: "https://agri.idaho.gov/animals/eggs-birds/egg-candlers-distributors/",
  citation_title: "ISDA — Egg Candlers & Distributors",
  statute_excerpt:
    "If an individual has less than 300 birds, that person can sell the eggs without having to adhere to these requirements; however, the eggs must be clean and the container must be labeled with the individual's name, address, phone number, and the words 'UNGRADED EGGS.'",
  conditions: [
    "Fewer than 300 birds; eggs must be clean",
    "Container labeled with producer's name, address, phone number, and 'UNGRADED EGGS'",
    "300 or more birds, or claiming a grade/size, requires an ISDA egg candler/distributor license under IDAPA 02.02.11",
  ],
  effective_date: null,
  last_verified_at: VERIFIED,
  tier: "agency_guidance",
};

const eggLicense: RuleTemplate = {
  slug: "candler-distributor-license",
  decision: "conditional",
  summary:
    "Selling eggs to retailers or for resale in Idaho requires an ISDA egg candler/distributor license; a producer selling their own eggs at the place of production is exempt from the distributor definition.",
  citation_url: "https://agri.idaho.gov/animals/eggs-birds/egg-candlers-distributors/",
  citation_title: "ISDA — Egg Candlers & Distributors",
  statute_excerpt:
    "An egg distributor is defined as any person having possession or control of eggs or egg products for the purpose of candling, grading, packing, selling, peddling, distributing, dealing in or trading in eggs or egg products for resale to a dealer in the state of Idaho – unless that person is the producer selling the eggs at the place of production.",
  conditions: [
    "ISDA egg candler/distributor license for anyone grading eggs or selling for resale",
    "Small-flock (<300 birds) producers may sell without the license only with the UNGRADED EGGS labeling",
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

export const idahoRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
