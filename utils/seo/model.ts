// Shared content model for the programmatic comparison/guide pages
// (/vs/*, /alternatives/*, /best/*). One source of truth: the page
// components render it as HTML, utils/geo/page-content.ts renders it as
// markdown for agent-view, and the sitemap/meta lookups enumerate it.

export interface SeoFaq {
  q: string;
  a: string;
}

export interface SeoTable {
  columns: string[];
  rows: string[][];
}

export interface SeoSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface SeoPick {
  name: string;
  bestFor: string;
  price: string;
  /** One decisive attribute, rhinovoice-style ("Who owns your customer list"). */
  fact?: { label: string; value: string };
  paragraphs: string[];
  link?: { href: string; label: string };
  /** True for the Self-sown pick so the renderer can label the bias. */
  ours?: boolean;
}

export interface SeoPageContent {
  kind: "vs" | "alternatives" | "best";
  /** Full path, e.g. /vs/shopify */
  path: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  /** Plain "we make one of these" honesty note right under the H1. */
  disclosure: string;
  intro: string[];
  table?: SeoTable;
  /** Narrative sections between the table and the picks. */
  sections: SeoSection[];
  /** Numbered picks (alternatives + best-of guides). */
  picks?: SeoPick[];
  myPick?: string[];
  actionSteps?: string[];
  faq: SeoFaq[];
  related: { href: string; label: string }[];
}

export type CompetitorSlug =
  | "shopify"
  | "etsy"
  | "barn2door"
  | "square-online"
  | "local-line"
  | "grazecart"
  | "facebook-marketplace"
  | "beefmaps";

export interface CompetitorProfile {
  slug: CompetitorSlug;
  name: string;
  url: string;
  bestFor: string;
  price: string;
  /** Where they honestly beat us — short clauses used across pages. */
  wins: string[];
  /** Where they fall short for our audience. */
  gaps: string[];
}

// Prices/features checked October 2026 against each vendor's public pricing
// pages. Keep the phrasing hedged ("from", "about") where vendors hide tiers
// behind sales calls.
// Exact-key Record (not Record<string, ...>) so indexed access stays
// defined under noUncheckedIndexedAccess.
export const COMPETITORS: Record<CompetitorSlug, CompetitorProfile> = {
  shopify: {
    slug: "shopify",
    name: "Shopify",
    url: "https://www.shopify.com",
    bestFor: "a general-purpose store with a huge app ecosystem",
    price:
      "From $39/mo (Basic) plus card processing; 2% extra per sale if you don't use Shopify Payments",
    wins: [
      "enormous app/theme ecosystem and 24/7 support",
      "scales from one product to a national brand without migrating",
      "mature checkout, discounts, and analytics out of the box",
    ],
    gaps: [
      "monthly rent before you sell anything, and the apps you need usually add their own",
      "your store lives on their terms — accounts get frozen and categories get restricted",
      "nothing about it is built for local food: no pickup market context, no farm discovery",
    ],
  },
  etsy: {
    slug: "etsy",
    name: "Etsy",
    url: "https://www.etsy.com",
    bestFor: "handmade sellers who want built-in buyer traffic",
    price:
      "$0.20 per listing + 6.5% transaction fee + ~3% + $0.25 processing; Offsite Ads take 12-15% when they claim the sale",
    wins: [
      "millions of buyers already searching for handmade goods",
      "zero setup — list in an afternoon, no store to build",
      "the default search destination for soap, candles, fiber, and craft",
    ],
    gaps: [
      "the stack of small fees quietly passes 10% of each order",
      "your shop is one policy change or suspension away from gone, with no appeal that feels human",
      "buyers remember Etsy, not you — no customer list you can take with you",
    ],
  },
  barn2door: {
    slug: "barn2door",
    name: "Barn2Door",
    url: "https://www.barn2door.com",
    bestFor: "established farms that want white-glove onboarding",
    price:
      "$119-$299/mo billed annually (Entrepreneur/Business/Scale) plus a $399-$599 one-time setup fee",
    wins: [
      "deep farm-specific features: subscriptions, sell-by-weight, delivery routing",
      "real humans onboard you and migrate your products",
      "built only for farms, so the defaults make sense for food",
    ],
    gaps: [
      "the entry price is real farm money: over $1,800 in year one before a single sale",
      "annual billing means you're committed long before you know it fits",
      "a hosted silo like the others — your store and customer data live in theirs",
    ],
  },
  "square-online": {
    slug: "square-online",
    name: "Square Online",
    url: "https://squareup.com/us/en/online-store",
    bestFor:
      "sellers who run a market-booth POS and online store from one account",
    price:
      "Free plan $0/mo + about 2.9% + 30c online processing; Plus $49/mo; Premium $149/mo",
    wins: [
      "the free plan is genuinely free — best zero-dollar way to take card orders online",
      "unified in-person + online: card reader at the market, same inventory online",
      "setup is fast and the hardware is everywhere",
    ],
    gaps: [
      "the free store is generic — no marketplace discovery, no farm context",
      "Square is a payment company with a terms-of-service; restricted categories get funds held",
      "your customer relationships live inside Square's ecosystem, not yours",
    ],
  },
  "local-line": {
    slug: "local-line",
    name: "Local Line",
    url: "https://www.localline.co",
    bestFor: "food hubs and farms selling wholesale/B2B or subscription boxes",
    price: "From $79/mo billed annually + 2.9% + 30c processing",
    wins: [
      "the strongest option here for wholesale price lists and B2B ordering",
      "subscription-box tooling is built in, not bolted on",
      "food-hub features (aggregating many producers) nothing else here matches",
    ],
    gaps: [
      "priced for real volume — $950+/yr is a hard sell for a farm just starting online",
      "annual billing and a platform you rent, not own",
      "overkill if you sell a dozen items at a market and want pre-orders",
    ],
  },
  grazecart: {
    slug: "grazecart",
    name: "GrazeCart",
    url: "https://www.grazecart.com",
    bestFor:
      "ranches selling variable-weight meat with catch-weight fulfillment",
    price: "$89/mo Starter ($1,068/yr); higher tiers are behind a sales call",
    wins: [
      "sell-by-weight done right: charge the actual weight of the cut at pack time",
      "built by the Seven Sons team — the workflow comes from a real ranch",
      "subscriptions, delivery zones, and pickup management designed for meat",
    ],
    gaps: [
      "over $1,000/yr at the entry tier, with the rest of the price list unpublished",
      "meat-first design is a poor fit for produce, baked goods, or mixed farm stores",
      "same rented-platform trade: your store exists at their discretion",
    ],
  },
  "facebook-marketplace": {
    slug: "facebook-marketplace",
    name: "Facebook Marketplace",
    url: "https://www.facebook.com/marketplace",
    bestFor: "free local-pickup reach where your customers already scroll",
    price:
      "Free for local pickup; shipped orders carry a 10% selling fee ($0.80 minimum)",
    wins: [
      "the largest local audience on earth, and listing costs nothing",
      "buyers are already there — no marketing required to get eyeballs",
      "great for moving surplus fast (a glut of eggs, end-of-market produce)",
    ],
    gaps: [
      "no store: no branding, no product pages, no reorder flow, no customer list",
      "messages, haggling, and no-shows become your order management",
      "food sellers get flagged by moderation bots that can't tell jam from contraband",
    ],
  },
  beefmaps: {
    slug: "beefmaps",
    name: "BeefMaps",
    url: "https://beefmaps.com",
    bestFor:
      "beef-only discovery — being found by buyers hunting ranch-direct beef",
    price:
      "A directory listing, not a store — see their site for listing terms",
    wins: [
      "laser-focused discovery: buyers arrive already wanting a quarter or half",
      "the Rancher Direct Certified badge is real trust signal in the beef world",
      "complements any store — a listing points buyers at wherever you sell",
    ],
    gaps: [
      "a directory, not a checkout — buyers still have to reach you and order somehow",
      "beef only: nothing for pork, poultry, eggs, produce, or anything else you sell",
      "no cart, no payments, no order management — you bring the store",
    ],
  },
};

export const SELFSOWN_PROFILE = {
  name: "Self-sown",
  bestFor: "selling local food and artisan goods with zero platform fees",
  price:
    "Free: unlimited listings, no mandatory transaction fees. Herd ($21/mo or $168/yr) adds custom domains, email flows, shipping labels, and AI tooling. Wrangler ($2,100 once) is lifetime.",
  url: "https://self-sown.com",
};

/** Standard closing CTA used on every comparison/guide page. */
export const SEO_CTA = {
  heading: "Try Self-sown free",
  body: "Unlimited listings, no platform fees, and your store belongs to you — not to us. Spin up a stall in minutes, keep it free forever, and only pay if the Herd features earn their keep.",
  buttonLabel: "Start selling",
  buttonHref: "/onboarding/new-account",
  secondaryLabel: "Browse the marketplace",
  secondaryHref: "/marketplace",
};

/** Honest dating note appended to every page (rhinovoice convention). */
export const PRICING_DISCLAIMER =
  "We checked prices and features for everything on this page in October 2026, against each vendor's own pricing page. This stuff changes constantly, so double-check before you commit.";
