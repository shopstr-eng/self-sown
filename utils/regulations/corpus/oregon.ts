// Wedge corpus — OREGON (OR). REVIEW STATUS: PENDING ATTORNEY REVIEW.
// Every row was encoded from the cited primary source (ORS chapter pages on
// oregonlegislature.gov, ODA guidance PDF, eCFR) and last verified by
// re-reading the source on 2026-11-07. Excerpts are verbatim from the cited
// text. Statutory effective dates were filled on 2026-11-09 from the enrolled
// OR session laws (oregonlegislature.gov chapter-law PDFs; see inline notes);
// the two ODA guidance rows keep effective_date null because guidance
// documents carry no effective date. The attorney reviewer must confirm
// every row.

import type { CorpusRule } from "../schema";
import { forChannels, oneChannel, type RuleTemplate } from "./expand";

const STATE = "OR";
const VERIFIED = "2026-11-07";

const ORS = "https://www.oregonlegislature.gov/bills_laws/ors/ors";
const CFR_RAW_MILK =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-L/part-1240/section-1240.61";
const CFR_EGG =
  "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-118/section-118.1";

// ---------------------------------------------------------------------------
// cottage_food — ORS 616.723 (residential-dwelling exemption)
// ---------------------------------------------------------------------------

const cottageExemption: RuleTemplate = {
  slug: "license-exemption",
  decision: "conditional",
  summary:
    "Oregon's cottage food exemption lets a home kitchen operate without a food establishment license when the foods are packaged and not potentially hazardous, every preparer holds a food handler certificate, and annual gross sales stay under $50,000 (CPI-adjusted).",
  citation_url: `${ORS}616.html`,
  citation_title:
    "ORS 616.723 — Exemption from ORS 616.695 to 616.755 for establishments in residential dwellings",
  statute_excerpt:
    "ORS 616.695 to 616.755 do not apply to a food establishment if: (a) The food establishment is located in a residential dwelling; (b) The foods prepared at the food establishment for public distribution are packaged and not potentially hazardous...; (d) The annual gross sales of foods prepared at the food establishment do not exceed $50,000, adjusted annually for inflation pursuant to the Consumer Price Index for All Urban Consumers, West Region (All Items)...; and (e) Each individual involved in the preparation of food at the food establishment for public distribution has successfully completed a food handler training program and holds a certificate issued under ORS 624.570.",
  conditions: [
    "Production in a residential dwelling; foods must be packaged and not potentially hazardous (requiring no temperature control)",
    "Annual gross sales of the foods must not exceed $50,000, adjusted annually for inflation (CPI-U West Region) — re-verify the current adjusted cap before relying on it",
    "Every individual preparing food must hold a food handler training certificate under ORS 624.570",
    "No sales to institutions: caterers, schools, day care centers, hospitals, nursing homes, correctional facilities, or restaurants (ORS 616.723(3))",
  ],
  // Current amendment: 2023 c.211, effective 2024-01-01 per the enrolled
  // session law (originally enacted 2015 c.453, effective 2016-01-01).
  effective_date: "2024-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageProducts: RuleTemplate = {
  slug: "allowed-products",
  decision: "conditional",
  summary:
    "Only packaged, non-potentially-hazardous foods may be produced: baked goods, confectionary items, coffee beans, teas, popcorn, jams, jellies, honey, syrups, fruit butters, nut mixes, repackaged freeze-dried or dehydrated foods, and powdered drink mixes. Foods containing cannabis are excluded.",
  citation_url: `${ORS}616.html`,
  citation_title: "ORS 616.723(2)(b) — Allowed cottage food products",
  statute_excerpt:
    "The foods prepared at the food establishment for public distribution are packaged and not potentially hazardous, including but not limited to baked goods, confectionary items, coffee beans, teas, popcorn, jams, jellies, honey, syrups, fruit butters, nut mixes, repackaged freeze-dried foods, repackaged dried and dehydrated foods and powdered drink mixes",
  conditions: [
    '"Food" does not include any article containing cannabis (ORS 616.723(1)(a))',
  ],
  // Current amendment: 2023 c.211, effective 2024-01-01 per the enrolled
  // session law.
  effective_date: "2024-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageLabeling: RuleTemplate = {
  slug: "labeling",
  decision: "conditional",
  summary:
    "Every cottage food product must bear the statutory homemade label, the establishment's name and phone number, and its address or a unique identification number.",
  citation_url: `${ORS}616.html`,
  citation_title: "ORS 616.723(6) — Cottage food label requirements",
  statute_excerpt:
    "This product is homemade, is not prepared in an inspected food establishment and must be stored and displayed separately if merchandised by a retailer.",
  conditions: [
    "Label must also include the name and phone number of the establishment and either its address or a unique identification number (ORS 616.723(6))",
    "Products merchandised by a retailer must be stored and displayed separately from other foods",
  ],
  // Current amendment: 2023 c.211, effective 2024-01-01 per the enrolled
  // session law.
  effective_date: "2024-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const cottageDirectChannels = ["farmers_market", "on_farm", "online_intrastate"];

const cottageFood: CorpusRule[] = [
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageExemption),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageProducts),
  ...forChannels(cottageDirectChannels, STATE, "cottage_food", cottageLabeling),
  oneChannel("online_intrastate", STATE, "cottage_food", {
    slug: "internet-mail-allowed",
    decision: "conditional",
    summary:
      "Oregon expressly allows cottage food sales directly to the end user in any manner — from the home, online, through the mail, and at events — subject to the exemption's conditions.",
    citation_url: `${ORS}616.html`,
    citation_title: "ORS 616.723(4) — Direct sales to end user in any manner",
    statute_excerpt:
      "A person may sell foods prepared in a food establishment described in subsection (2) of this section directly to the end user in any manner, including from the home, online, through the mail and at events.",
    conditions: [
      "All exemption conditions still apply (packaged, non-potentially-hazardous, label, sales cap, food handler certificates)",
    ],
    // Current amendment: 2023 c.211, effective 2024-01-01 per the enrolled
    // session law.
    effective_date: "2024-01-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("online_interstate", STATE, "cottage_food", {
    slug: "interstate-destination-law",
    decision: "conditional",
    summary:
      "Oregon law does not prohibit mailing cottage food to other states, but ODA defers to the destination state: confirm the receiving state's cottage food law before shipping across state lines.",
    citation_url:
      "https://www.oregon.gov/oda/Documents/Publications/FoodSafety/CottageFoodExemptionFAQENG.pdf",
    citation_title: "ODA — Cottage Food Exemption FAQ",
    statute_excerpt:
      "We do not have jurisdictional authority in other states to make that determination. Please reach out to the state(s) where you are going to sell your cottage food for any laws or rules that may apply.",
    conditions: [
      "Oregon's exemption allows online and mail sales to end users (ORS 616.723(4)); the destination state's cottage food law governs whether the sale is lawful there",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
  oneChannel("retail", STATE, "cottage_food", {
    slug: "retail-allowed",
    decision: "conditional",
    summary:
      "Packaged cottage foods may be sold to a retailer (coffee shops included, restaurants excluded) if the retailer agrees to the statutory storage, display, and labeling conditions.",
    citation_url: `${ORS}616.html`,
    citation_title: "ORS 616.723(5) — Sales to retailers",
    statute_excerpt:
      "A person may sell packaged foods prepared in a food establishment described in subsection (2) of this section to a retailer if the retailer agrees to: ...",
    conditions: [
      "Retailer must agree to store and display the products separately and honor the homemade label statement (ORS 616.723(5)-(6))",
      '"Retailer" includes coffee shops and excludes restaurants — restaurant sales remain prohibited (ORS 616.723(1)(c), (3))',
    ],
    // Current amendment: 2023 c.211, effective 2024-01-01 per the enrolled
    // session law.
    effective_date: "2024-01-01",
    last_verified_at: VERIFIED,
    tier: "statute_verified",
  }),
  oneChannel("wholesale", STATE, "cottage_food", {
    slug: "wholesale-limited",
    decision: "conditional",
    summary:
      "ODA allows cottage food sales to some commercial entities for wholesale distribution only if the requirements of OAR 603-025-0320(4) are met.",
    citation_url:
      "https://www.oregon.gov/oda/Documents/Publications/FoodSafety/CottageFoodExemptionFAQENG.pdf",
    citation_title: "ODA — Cottage Food Exemption FAQ",
    statute_excerpt:
      "You may also sell your cottage food products to some commercial entities for wholesale distribution if you meet the requirements described in 603-025-0320(4).",
    conditions: [
      "Wholesale distribution is available only through the OAR 603-025-0320(4) path — confirm the rule's requirements with ODA before wholesaling",
      "Unpackaged cottage foods may not be sold to a retail store for further distribution",
    ],
    effective_date: null,
    last_verified_at: VERIFIED,
    tier: "agency_guidance",
  }),
];

// ---------------------------------------------------------------------------
// raw_milk — ORS 621.012 (small-scale on-farm exception) + 621.116 (cow retail
// ban) + 21 CFR 1240.61 (interstate)
// ---------------------------------------------------------------------------

const rawMilkSmallFarm: RuleTemplate = {
  slug: "small-scale-on-farm",
  decision: "conditional",
  summary:
    "Oregon exempts very small producers — no more than 3 calved cows, 9 lactating sheep, or 9 lactating goats — from dairy licensing, grading, and labeling requirements, but only for raw milk sold directly to the consumer at the premises where it is produced.",
  citation_url: `${ORS}621.html`,
  citation_title: "ORS 621.012 — Exception for small-scale on-farm sales",
  statute_excerpt:
    "The provisions of ORS 621.062, 621.070, 621.072, 621.076, 621.084, 621.088, 621.116, 621.117 and 621.259 and standards developed under ORS 621.060, 621.083 or 621.224 do not apply to a person owning not more than three dairy cows that have calved at least once, nine sheep that have lactated at least once or nine goats that have lactated at least once... only if: (1) The milk is sold directly to the consumer at the premises where produced; and (2) No more than two producing dairy cows, nine producing sheep or nine producing goats are located on the premises where the milk is produced.",
  conditions: [
    "Herd limits: no more than 3 dairy cows that have calved, 9 lactating sheep, or 9 lactating goats; no more than 2 producing cows (or 9 producing sheep/goats) on the premises",
    "Sales only directly to the consumer at the premises where the milk is produced — no delivery, farmers markets, or retail",
  ],
  // Current amendment: HB 2446 (2015 c.58 §1, removed the no-advertising
  // condition), effective 2016-01-01 per the enrolled session law.
  effective_date: "2016-01-01",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilkOffFarm: RuleTemplate = {
  slug: "cow-milk-retail-prohibited",
  decision: "conditional",
  summary:
    "Off the farm, Oregon prohibits retail sale of unpasteurized cow milk entirely; raw goat or sheep milk may reach retail or delivery channels only with ODA dairy licensing outside the small-scale exemption.",
  citation_url: `${ORS}621.html`,
  citation_title:
    "ORS 621.116 — Prohibition against retail sale of unpasteurized milk from cows",
  statute_excerpt:
    "A person may not sell or distribute for sale unpasteurized milk or fluid milk from cows, or dairy products from unpasteurized milk or fluid milk from cows, other than to a distributor, producer-distributor, dairy products plant licensee or nonprocessing cooperative.",
  conditions: [
    "Unpasteurized cow milk may never be sold at retail (limited cheese-curing exception under ORS 621.116)",
    "Raw goat/sheep milk sold off-premises requires ODA licensing under ORS 621.070 — the ORS 621.012 exemption covers only on-premises direct sales",
  ],
  // Enacted 1999 c.937 (SB 1212) §2, effective 1999-10-23 per the enrolled
  // session law.
  effective_date: "1999-10-23",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const rawMilk: CorpusRule[] = [
  oneChannel("on_farm", STATE, "raw_milk", rawMilkSmallFarm),
  ...forChannels(
    ["farmers_market", "retail", "online_intrastate"],
    STATE,
    "raw_milk",
    rawMilkOffFarm
  ),
  oneChannel("wholesale", STATE, "raw_milk", {
    slug: "wholesale-licensed-plants-only",
    decision: "conditional",
    summary:
      "Unpasteurized cow milk may be distributed only to licensed dairy channels — a distributor, producer-distributor, dairy products plant licensee, or nonprocessing cooperative.",
    citation_url: `${ORS}621.html`,
    citation_title: "ORS 621.116 — Permitted distribution channels",
    statute_excerpt:
      "A person may not sell or distribute for sale unpasteurized milk or fluid milk from cows, or dairy products from unpasteurized milk or fluid milk from cows, other than to a distributor, producer-distributor, dairy products plant licensee or nonprocessing cooperative.",
    conditions: [
      "Buyer must hold the corresponding ODA dairy license under ORS chapter 621",
    ],
    // Enacted 1999 c.937 (SB 1212) §2, effective 1999-10-23 per the enrolled
    // session law.
    effective_date: "1999-10-23",
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
// eggs — ORS 632.715 (handler license + direct-producer exemption)
// ---------------------------------------------------------------------------

const eggDirectExemption: RuleTemplate = {
  slug: "producer-direct-exemption",
  decision: "conditional",
  summary:
    "A producer selling and delivering eggs of their own production directly to an individual consumer is exempt from Oregon's egg handler license; sales to retailers or other egg handlers require the license.",
  citation_url: `${ORS}632.html`,
  citation_title: "ORS 632.715 — Egg handler's license; exemptions",
  statute_excerpt:
    "Unless the person holds a permit issued under ORS 632.730, a person may not sell or distribute within this state any eggs to consumers or to retailers without having first obtained an egg handler's license from the State Department of Agriculture. The license is not required: (a) Of a producer selling and delivering eggs of the producer's own production directly to an individual consumer",
  conditions: [
    "License exemption covers only the producer's own eggs sold and delivered directly to an individual consumer",
    "Container labeling under ORS 632.771 still applies; the fee and labeling exemption in ORS 632.741(2)(e) covers only eggs sold by a producer to consumers at the place of production",
  ],
  // Current amendment: SB 507 (2023 c.181 §5), effective 2023-09-24 (91st day
  // after adjournment sine die) per the enrolled session law.
  effective_date: "2023-09-24",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggHandlerLicense: RuleTemplate = {
  slug: "handler-license",
  decision: "conditional",
  summary:
    "Selling eggs to retailers or other egg handlers in Oregon requires an annual egg handler's license from ODA; the producer-direct exemption does not extend to retail or wholesale channels.",
  citation_url: `${ORS}632.html`,
  citation_title: "ORS 632.715 — Egg handler's license",
  statute_excerpt:
    "A person may not sell or distribute within this state any eggs to consumers or to retailers without having first obtained an egg handler's license from the State Department of Agriculture.",
  conditions: [
    "Annual egg handler's license from ODA (expires June 30); a duplicate license copy must be displayed at each location where eggs are candled or graded",
    "Eggs sold to retailers must be candled, graded, and labeled per ORS 632.705 to 632.815",
  ],
  // Current amendment: SB 507 (2023 c.181 §5), effective 2023-09-24 (91st day
  // after adjournment sine die) per the enrolled session law.
  effective_date: "2023-09-24",
  last_verified_at: VERIFIED,
  tier: "statute_verified",
};

const eggs: CorpusRule[] = [
  ...forChannels(
    ["farmers_market", "on_farm", "online_intrastate"],
    STATE,
    "eggs",
    eggDirectExemption
  ),
  ...forChannels(["retail", "wholesale"], STATE, "eggs", eggHandlerLicense),
  oneChannel("online_interstate", STATE, "eggs", eggHandlerLicense),
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

export const oregonRules: CorpusRule[] = [...cottageFood, ...rawMilk, ...eggs];
