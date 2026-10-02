// Content for the /alternatives/<competitor> listicle pages.

import {
  COMPETITORS,
  SELFSOWN_PROFILE,
  type CompetitorSlug,
  type SeoPageContent,
  type SeoPick,
} from "./model";

const DISCLOSURE =
  "Full disclosure: Self-sown is ours, and it's on this list. We've still told you when something else is the better pick — check the \"best for\" lines before the names.";

const us = (fact: string, paragraphs: string[]): SeoPick => ({
  name: `${SELFSOWN_PROFILE.name} (ours)`,
  bestFor: SELFSOWN_PROFILE.bestFor,
  price: SELFSOWN_PROFILE.price,
  fact: { label: "Platform fees", value: fact },
  paragraphs,
  link: { href: "/onboarding/new-account", label: "Start free on Self-sown" },
  ours: true,
});

const comp = (
  slug: CompetitorSlug,
  factLabel: string,
  factValue: string,
  paragraphs: string[]
): SeoPick => {
  const c = COMPETITORS[slug];
  return {
    name: c.name,
    bestFor: c.bestFor,
    price: c.price,
    fact: { label: factLabel, value: factValue },
    paragraphs,
    link: { href: c.url, label: `Visit ${c.name}` },
  };
};

export const ALTERNATIVES_PAGES: Record<string, SeoPageContent> = {
  shopify: {
    kind: "alternatives",
    path: "/alternatives/shopify",
    h1: "The best Shopify alternatives for farm & food sellers (2026)",
    metaTitle: "5 Best Shopify Alternatives for Farm & Food Sellers (2026)",
    metaDescription:
      "Shopify's $39/mo plus apps is overkill for selling local food. The best Shopify alternatives for farmers, ranchers, and makers — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Shopify is excellent general-purpose software being used for a job it wasn't built for. If you sell eggs, beef, jam, or soap to people within driving distance, you're paying $39+/mo (plus the apps that make it fit) for infrastructure aimed at national brands.",
      "These are the alternatives worth your time, in the order we'd try them.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        [
          "Self-sown (ours)",
          "Local food & artisan sellers who want zero fees",
          "Free; Herd $21/mo optional",
        ],
        [
          "Square Online",
          "Pairing a market POS with online orders",
          "Free + ~2.9% + 30c online",
        ],
        [
          "Barn2Door",
          "Established farms wanting white-glove setup",
          "$119-299/mo + setup fee",
        ],
        [
          "Etsy",
          "Handmade goods that need buyer traffic",
          "~10% of each sale, stacked fees",
        ],
        [
          "Facebook Marketplace",
          "Free local reach, no store needed",
          "Free local; 10% shipped",
        ],
      ],
    },
    sections: [
      {
        heading: "Why food sellers leave Shopify",
        paragraphs: [
          "It's rarely one thing. It's the monthly bill arriving before the season starts, the third app subscription needed to do pre-orders sanely, and the realization that none of it helps the people ten miles away find your eggs. The alternatives below each fix a different part of that.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% platform fees", [
        "Self-sown replaces the whole Shopify-plus-apps stack for a local food seller: unlimited free listings, a storefront with a custom domain option, order management, and payments that settle directly to you — Bitcoin (Lightning/Cashu), cards via your own Stripe or Square account, or Venmo/Zelle/cash.",
        "The difference that outlasts the price: your store lives on open Nostr relays under your keys, so no frozen accounts, no restricted categories, and your customer list is portable. There's even a built-in Shopify migration to import your products.",
      ]),
      comp("square-online", "Standout", "The free POS-to-online combo", [
        "If you already take cards at the market on a Square reader, Square Online adds a free online store on the same inventory. It's the smoothest in-person-plus-online package anywhere.",
        "The catch: your store is generic, there's no marketplace discovery, and Square holds both the money and the relationship.",
      ]),
      comp("barn2door", "Standout", "White-glove farm onboarding", [
        "The farm-specific incumbent: subscriptions, sell-by-weight, delivery routing, and humans who set it all up. If you're an established farm with budget, it's the depth play.",
        "At $119-299/mo billed annually plus a $399-599 setup fee, it's the opposite of a low-risk experiment.",
      ]),
      comp("etsy", "Standout", "Built-in handmade buyer traffic", [
        "For soap, candles, fiber, and craft, Etsy's search audience is unmatched — a new shop can sell the day it opens.",
        "The ~10% stacked fees and zero customer ownership make it a better customer-acquisition channel than a home.",
      ]),
      comp("facebook-marketplace", "Standout", "Free local reach", [
        "The largest local audience anywhere, free for porch pickup. Perfect for surplus and first sales.",
        "It's a feed, not a store: no brand, no cart, no reorders — and moderation bots that flag jam as contraband.",
      ]),
    ],
    myPick: [
      "Leaving Shopify to sell local food or artisan goods: Self-sown, free, and you can run it alongside Shopify while you migrate.",
      "Leaving Shopify because you outgrew it in the other direction — national brand, warehouse, apps: honestly, stay. That's what Shopify is for.",
    ],
    actionSteps: [
      "List your three best sellers on Self-sown (free) and put the link in your farm's social bios.",
      "Run both stores for a month and compare what each dollar of sales actually cost you.",
      "Cancel Shopify when the free store carries the load — not before.",
    ],
    faq: [
      {
        q: "What's the cheapest Shopify alternative?",
        a: "Self-sown and Square Online are both $0/mo. Square takes ~2.9% + 30c online processing; Self-sown takes no platform fee at all, and Bitcoin payments have no processing fee.",
      },
      {
        q: "Can I migrate my Shopify products?",
        a: "Self-sown has a built-in Shopify migration in the onboarding flow. For the others you're re-listing by hand.",
      },
      {
        q: "Which alternative has Shopify's app store?",
        a: "None — that's Shopify's moat. The question is whether a local food seller needs any of it. In our experience the needed features (orders, pickup/shipping, email, custom domain) are table stakes elsewhere.",
      },
    ],
    related: [
      { href: "/vs/shopify", label: "Self-sown vs Shopify, in depth" },
      {
        href: "/best/online-marketplace-for-farmers",
        label: "Best online marketplace for farmers",
      },
    ],
  },

  etsy: {
    kind: "alternatives",
    path: "/alternatives/etsy",
    h1: "The best Etsy alternatives for makers & food producers (2026)",
    metaTitle: "5 Best Etsy Alternatives: Keep Your Customer List (2026)",
    metaDescription:
      "Etsy's stacked fees pass 10% and the customer belongs to Etsy. The best Etsy alternatives for soap, candle, fiber, and food sellers — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Nobody leaves Etsy because it doesn't work — they leave because the math stops working. Listing fee, 6.5% transaction, ~3% + $0.25 processing, and 12-15% on Offsite Ads they can't turn off: a $30 order easily loses $4+ before materials.",
      "Here's where sellers go instead, including the one we build.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        [
          "Self-sown (ours)",
          "Makers with any repeat/local buyers",
          "Free; 0% platform fees",
        ],
        [
          "Etsy (stay)",
          "Brand-new shops needing search traffic",
          "~10%+ stacked per-sale fees",
        ],
        ["Shopify", "Building a standalone brand site", "$39/mo + apps"],
        [
          "Square Online",
          "Craft-fair POS + simple online store",
          "Free + processing",
        ],
        [
          "Facebook Marketplace",
          "Local pickup sales",
          "Free local; 10% shipped",
        ],
      ],
    },
    sections: [
      {
        heading: "What to optimize for",
        paragraphs: [
          "Etsy's fee is really two products: a store (commodity, available free elsewhere) and an audience (genuinely scarce). Before switching, decide which one you're paying for. If most of your orders come from people who already know you, you're paying audience prices for store features.",
        ],
      },
    ],
    picks: [
      us("None — you keep 100% of each sale", [
        "Self-sown is the anti-Etsy on fees and ownership: free unlimited listings, no transaction fees, and a store on open Nostr relays that no policy change can suspend. Your buyer list is yours — export it, move it, keep it.",
        "The honest gap: we don't have Etsy's search traffic. Self-sown works best once you have any way to reach buyers yourself — a market booth, an Instagram following, a neighborhood.",
      ]),
      comp("shopify", "Standout", "A real brand site of your own", [
        "If you're graduating from marketplace to brand — custom everything, email marketing, ad funnels — Shopify is the conventional way up.",
        "Budget $60-100/mo with apps, and know that your store is rented: frozen payouts and category restrictions happen there too.",
      ]),
      comp(
        "square-online",
        "Standout",
        "Craft fairs plus online, one account",
        [
          "For makers who sell at fairs, Square's reader-plus-free-store combo keeps one inventory across the booth and the web.",
          "Generic storefront, no discovery, and the money sits in Square's ecosystem.",
        ]
      ),
      comp("facebook-marketplace", "Standout", "Free local sales", [
        "For bulky or hyperlocal goods — pottery, furniture-adjacent crafts, baked goods — local pickup on Marketplace costs nothing and reaches everyone nearby.",
        "No store, no brand, no customer list. Treat it as free ads, not a business.",
      ]),
      {
        name: "Etsy (yes, stay)",
        bestFor: "new shops with zero audience",
        price: COMPETITORS.etsy.price,
        paragraphs: [
          "This bears repeating because everyone on the internet will tell you to rage-quit Etsy: if you have no audience, Etsy's search traffic is worth its fees. New shops should start there.",
          "The move is to graduate, not to quit: Etsy finds the customer, your own store keeps them.",
        ],
      },
    ],
    myPick: [
      "Repeat buyers already exist: move them to Self-sown and keep the 10%+.",
      "No audience at all: Etsy first, Self-sown as the store you point your packaging at from day one.",
    ],
    actionSteps: [
      "Open a free Self-sown stall and print its link (or QR) on every package you ship.",
      "Keep Etsy running for discovery; don't burn the traffic bridge.",
      "Watch where repeat orders land over a season — that's your answer.",
    ],
    faq: [
      {
        q: "What are Etsy's real fees in 2026?",
        a: "$0.20/listing + 6.5% of the order total (including shipping) + ~3% + $0.25 processing. Offsite Ads add 12-15% on attributed sales and are mandatory once you pass $10k/yr.",
      },
      {
        q: "Is there a free Etsy alternative with the same traffic?",
        a: "No, and anyone claiming otherwise is selling you something. Etsy's traffic is the product. The free alternatives trade traffic for ownership and zero fees.",
      },
      {
        q: "Can I sell food on these platforms?",
        a: "Etsy restricts many food categories; Self-sown doesn't gatekeep — your local cottage-food and health laws are the rules that apply.",
      },
    ],
    related: [
      { href: "/vs/etsy", label: "Self-sown vs Etsy, in depth" },
      {
        href: "/best/marketplace-for-handmade-soap-candles",
        label: "Best marketplace for soap & candle makers",
      },
      {
        href: "/best/marketplace-for-wool-fiber",
        label: "Best marketplace for wool & fiber",
      },
    ],
  },

  barn2door: {
    kind: "alternatives",
    path: "/alternatives/barn2door",
    h1: "The best Barn2Door alternatives for farms (2026)",
    metaTitle: "5 Best Barn2Door Alternatives: Honest Cost Comparison (2026)",
    metaDescription:
      "Barn2Door costs $1,800+ in year one. The best Barn2Door alternatives for farms — from free (Self-sown) to full-service — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Barn2Door is good software with a hard price: $119-299/mo billed annually plus a $399-599 setup fee — $1,827 minimum in year one. Farms start looking for alternatives at renewal time, or right after the sales call.",
      "Here's the honest landscape, cheapest first.",
    ],
    table: {
      columns: ["Option", "Best for", "Year-one cost"],
      rows: [
        [
          "Self-sown (ours)",
          "Any farm selling direct",
          "$0 (Herd $168/yr optional)",
        ],
        ["Square Online", "Market booth + online orders", "$0 + processing"],
        ["Local Line", "Wholesale & food hubs", "~$950+/yr"],
        ["GrazeCart", "Sell-by-weight meat", "$1,068/yr Starter"],
        ["Shopify", "General-purpose DIY", "~$470/yr + apps"],
      ],
    },
    sections: [
      {
        heading: "What Barn2Door's fee actually buys",
        paragraphs: [
          'Three things: farm-depth features (subscriptions, sell-by-weight, routing), human onboarding, and the comfort of the incumbent. If you use all three, it can be worth it. If you mostly needed "a store that takes orders," you\'re paying incumbent prices for a commodity — the alternatives below sell the same dozen eggs for less.',
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% fees", [
        "Self-sown covers the core of what most farms use Barn2Door for — listings, orders, pickup/shipping coordination, payments — at $0. Payments settle directly to you (Bitcoin, your own Stripe/Square, or cash apps), and the store lives on open Nostr relays you own.",
        "Honest gaps vs Barn2Door: catch-weight fulfillment and delivery-route optimization are deeper there, and nobody will onboard you by hand. If those two are must-haves, look below.",
      ]),
      comp("square-online", "Standout", "Free plan + market POS", [
        "Free online store on the same Square account you already take cards with at the market. Zero dollars, zero setup friction.",
        "No farm features, no discovery — it's a checkout with a storefront attached.",
      ]),
      comp("local-line", "Standout", "Wholesale & food hubs", [
        "If what you actually wanted from Barn2Door was wholesale price lists or multi-farm hub tooling, Local Line is the specialist and slightly cheaper.",
        "Still ~$950+/yr billed annually, so the same question applies: are you doing B2B volume that justifies it?",
      ]),
      comp("grazecart", "Standout", "Sell-by-weight meat", [
        "Built by ranchers for ranches: catch-weight charging, delivery zones, meat-shaped everything.",
        "$1,068/yr to start and unpublished tiers above — a narrower, also-not-cheap Barn2Door.",
      ]),
      comp("shopify", "Standout", "Total DIY flexibility", [
        "The general-purpose option: infinite apps, infinite themes, $39/mo plus whatever the apps cost.",
        "Nothing farm-specific, and you're back to renting a store on someone else's terms.",
      ]),
    ],
    myPick: [
      "Default answer: Self-sown free. It covers what 80% of farms actually use, and the $1,800 stays in the farm.",
      "If you truly need routing + catch-weight + white-glove onboarding: Barn2Door or GrazeCart, eyes open about the annual bill.",
    ],
    actionSteps: [
      "List your full catalog on Self-sown free and share the link with your ten best customers.",
      "Run a month of orders through it before signing anything annual.",
      "If a specific Barn2Door feature is the blocker, name it — then check Local Line or GrazeCart for exactly that feature.",
    ],
    faq: [
      {
        q: "What's the cheapest Barn2Door alternative?",
        a: "Self-sown ($0, no platform fees) and Square Online ($0/mo + processing). Barn2Door's entry is $1,827 in year one; even Self-sown's fully-loaded Herd plan is $168/yr.",
      },
      {
        q: "Which alternative has sell-by-weight?",
        a: "GrazeCart does true catch-weight best. Self-sown supports weight variants with per-variant pricing. Local Line and Barn2Door sit in between.",
      },
      {
        q: "Can I switch mid-season?",
        a: "Yes — nothing stops you running a free Self-sown store alongside Barn2Door and moving customers over gradually. Most farms transition in a few weeks.",
      },
    ],
    related: [
      { href: "/vs/barn2door", label: "Self-sown vs Barn2Door, in depth" },
      {
        href: "/best/online-marketplace-for-farmers",
        label: "Best online marketplace for farmers",
      },
      {
        href: "/best/ecommerce-for-raw-milk-dairies",
        label: "Best e-commerce for raw milk dairies",
      },
    ],
  },

  "square-online": {
    kind: "alternatives",
    path: "/alternatives/square-online",
    h1: "The best Square Online alternatives (2026)",
    metaTitle: "5 Best Square Online Alternatives for Local Sellers (2026)",
    metaDescription:
      "Square Online is a fine free checkout but a generic store. The best Square Online alternatives for farm, food, and artisan sellers — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Square Online's free plan is one of the best deals in e-commerce, so most sellers looking for an alternative don't have a price problem — they have a fit problem. The store is generic, there's no discovery, and everything lives inside Square's ecosystem.",
      "These alternatives each fix a different piece of that.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        [
          "Self-sown (ours)",
          "Local food/artisan sellers who want discovery + ownership",
          "Free; 0% platform fees",
        ],
        ["Shopify", "Full DIY brand control", "$39/mo + apps"],
        ["Etsy", "Handmade goods needing traffic", "~10% per sale"],
        [
          "Barn2Door",
          "Farm-depth features + onboarding",
          "$119-299/mo + setup",
        ],
        [
          "Facebook Marketplace",
          "Free local pickup sales",
          "Free local; 10% shipped",
        ],
      ],
    },
    sections: [
      {
        heading: "Keep Square for what it's good at",
        paragraphs: [
          "A useful framing before you switch anything: Square the card processor is excellent — fast, cheap, everywhere. Square Online the storefront is the weak link. Several options below (including ours) let you keep Square as the payment rail while replacing the store.",
        ],
      },
    ],
    picks: [
      us("None — and you can keep Square as your card processor", [
        "Self-sown is a free storefront and marketplace you own, with local-food discovery and AI-agent-readable listings. Connect your existing Square account for cards (or Stripe, or Bitcoin Lightning/Cashu, or cash apps) — the money still settles straight to you, never through us.",
        "You gain: a real store with your brand, a portable customer list on open relays, and zero platform fees. You lose: Square's unified POS inventory sync.",
      ]),
      comp("shopify", "Standout", "Total storefront control", [
        "If 'generic' is your complaint, Shopify is the maximal fix — every pixel customizable, an app for everything.",
        "You pay for it monthly, forever, and the store is still rented.",
      ]),
      comp("etsy", "Standout", "Instant buyer traffic", [
        "The opposite trade from Square: real discovery from millions of handmade buyers, in exchange for ~10% stacked fees and zero customer ownership.",
      ]),
      comp("barn2door", "Standout", "Serious farm operations", [
        "If you've outgrown Square into subscriptions, delivery routing, and sell-by-weight, Barn2Door is the farm-grade upgrade — at farm-grade prices.",
      ]),
      comp("facebook-marketplace", "Standout", "Zero-commitment local sales", [
        "If the online store was overkill and your buyers are all within 20 miles, Marketplace's free local pickup may be all you need — with a store link in the listing when you're ready for one.",
      ]),
    ],
    myPick: [
      "Want a store you own without losing Square payments: Self-sown, free, Square connected as the card rail.",
      "Want maximum storefront customization and don't mind rent: Shopify.",
    ],
    actionSteps: [
      "Open a free Self-sown stall and connect your existing Square account for cards.",
      "Put the store link anywhere the Square link lived — bios, QR codes, receipts.",
      "Keep the Square reader for in-person; that part was never the problem.",
    ],
    faq: [
      {
        q: "Can I keep using Square for payments if I switch stores?",
        a: "Yes on Self-sown — Square is a supported card processor, connected to your own account. Most other platforms force their own rail.",
      },
      {
        q: "Is Square Online really free?",
        a: "$0/mo, yes — you pay ~2.9% + 30c online processing per sale. Plus ($49/mo) and Premium ($149/mo) add features like a custom domain and lower rates.",
      },
      {
        q: "What's the best alternative with marketplace discovery?",
        a: "Self-sown for local food and artisan goods; Etsy for handmade. Square Online has no discovery at all — that's usually why sellers leave.",
      },
    ],
    related: [
      {
        href: "/vs/square-online",
        label: "Self-sown vs Square Online, in depth",
      },
      {
        href: "/best/online-store-for-farmers-market-vendors",
        label: "Best online store for market vendors",
      },
    ],
  },

  "local-line": {
    kind: "alternatives",
    path: "/alternatives/local-line",
    h1: "The best Local Line alternatives (2026)",
    metaTitle: "5 Best Local Line Alternatives for Farms (2026)",
    metaDescription:
      "Local Line starts at ~$950/yr billed annually. The best Local Line alternatives for farms and food hubs — from free to full-service — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Local Line is the food-hub specialist: wholesale price lists, multi-producer aggregation, subscription boxes. Farms look for alternatives when they're paying ~$950/yr (billed annually) for B2B machinery their direct-to-consumer store doesn't use.",
      "Here's the field, honestly assessed.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Self-sown (ours)", "Direct-to-consumer farm stores", "Free; 0% fees"],
        ["Barn2Door", "Full-service farm platform", "$119-299/mo + setup"],
        ["Square Online", "Simple store + market POS", "Free + processing"],
        ["GrazeCart", "Sell-by-weight meat", "$89/mo Starter"],
        ["Shopify", "DIY everything", "$39/mo + apps"],
      ],
    },
    sections: [
      {
        heading: "First, check whether you used the B2B features",
        paragraphs: [
          "This is the whole decision. If wholesale price lists or hub aggregation were paying their way, leaving Local Line means giving up the best version of those features on the market. If you were using it as a consumer storefront, you were driving a freight truck to the farmers market — the alternatives are all cheaper.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% fees", [
        "For direct-to-consumer sales, Self-sown replaces the consumer half of Local Line at $0: unlimited listings, orders, pickup/shipping coordination, and payments that settle straight to you.",
        "What you give up: wholesale price lists and hub aggregation. What you gain: ownership (your store lives on open Nostr relays) and a bill of zero.",
      ]),
      comp("barn2door", "Standout", "White-glove farm platform", [
        "The closest like-for-like swap: deep farm features plus human onboarding. More expensive than Local Line, but some farms prefer the ecosystem and support.",
      ]),
      comp("square-online", "Standout", "Free + market POS", [
        "The zero-cost way to keep taking online orders, unified with your market card reader. No farm features at all — it's a checkout.",
      ]),
      comp("grazecart", "Standout", "Meat-specific fulfillment", [
        "If your Local Line usage was really 'sell meat by weight online,' GrazeCart is the specialist with catch-weight done properly.",
      ]),
      comp("shopify", "Standout", "Build whatever you want", [
        "The DIY ceiling: any feature exists as an app, at the cost of monthly rent and total responsibility for assembling it.",
      ]),
    ],
    myPick: [
      "Consumer sales only: Self-sown, free.",
      "Wholesale or food hub is the business: honestly, stay on Local Line — that's the one thing it does better than everyone.",
    ],
    actionSteps: [
      "Export your Local Line customer list before anything else.",
      "Open a free Self-sown store for your consumer sales.",
      "Only renew Local Line if the wholesale features paid for themselves last season.",
    ],
    faq: [
      {
        q: "What's the cheapest Local Line alternative?",
        a: "Self-sown is free with no platform fees; Square Online is $0/mo plus processing. Both undercut Local Line's ~$950/yr entry by the entire amount.",
      },
      {
        q: "Which alternative handles food hubs?",
        a: "Honestly, Local Line is the best food-hub software here — if that's your business, the alternatives are downgrades. Barn2Door is the closest.",
      },
      {
        q: "Can I keep wholesale on Local Line and move retail off?",
        a: "Yes, and several farms do exactly that: Local Line for the restaurant accounts, a free Self-sown store for everyone else.",
      },
    ],
    related: [
      { href: "/vs/local-line", label: "Self-sown vs Local Line, in depth" },
      {
        href: "/best/online-marketplace-for-farmers",
        label: "Best online marketplace for farmers",
      },
    ],
  },

  grazecart: {
    kind: "alternatives",
    path: "/alternatives/grazecart",
    h1: "The best GrazeCart alternatives for ranches (2026)",
    metaTitle: "5 Best GrazeCart Alternatives for Meat & Ranch Sales (2026)",
    metaDescription:
      "GrazeCart's $89/mo Starter is great for catch-weight meat but steep for simple ranch stores. The best GrazeCart alternatives — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "GrazeCart is the sell-by-weight specialist, and at $89/mo ($1,068/yr) for Starter — with every higher tier behind a sales call — ranches reasonably ask what else is out there. The answer depends almost entirely on one question: do you need true catch-weight fulfillment?",
      "Here's the field for ranches.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        [
          "Self-sown (ours)",
          "Priced cuts, bundles, shares & deposits",
          "Free; 0% fees",
        ],
        [
          "Barn2Door",
          "Full farm platform with meat features",
          "$119-299/mo + setup",
        ],
        ["BeefMaps", "Being found by beef buyers", "Directory listing"],
        ["Shopify", "DIY with apps", "$39/mo + apps"],
        ["Square Online", "Free checkout + POS", "Free + processing"],
      ],
    },
    sections: [
      {
        heading: "The catch-weight question",
        paragraphs: [
          "Catch-weight means charging the exact packed weight of each cut after fulfillment — the ribeye listed at ~1.2 lb that actually weighs 1.34. GrazeCart does this better than anyone. But many ranches don't need it: priced cuts, curated bundles, and quarters/halves sold by deposit sidestep the whole problem, and every alternative below handles those fine.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% fees", [
        "Self-sown handles the way most direct-to-consumer ranches actually sell: priced cuts, bundle boxes, and shares by deposit. Weight and volume variants with per-variant pricing are built in, payments (Bitcoin, cards via your Stripe/Square, or cash apps) settle directly to you, and the store is free.",
        "Honest gap: no catch-weight charging. If your fulfillment is built on exact packed weights, GrazeCart or Barn2Door is the honest recommendation.",
      ]),
      comp("barn2door", "Standout", "Full farm operations", [
        "The other farm-grade platform: subscriptions, routing, sell-by-weight support, and human onboarding.",
        "Even pricier than GrazeCart — $1,827+ in year one — so it's for established operations, not experiments.",
      ]),
      comp("beefmaps", "Standout", "Beef-buyer discovery", [
        "Not a store — a directory of rancher-direct beef with a certification badge buyers trust. Whatever store you choose, a BeefMaps listing sends high-intent buyers to it.",
      ]),
      comp("shopify", "Standout", "Custom everything", [
        "There are sell-by-weight apps for Shopify, so a patient operator can assemble a GrazeCart-like stack — at $39/mo plus app fees plus your own setup time.",
      ]),
      comp("square-online", "Standout", "Free and simple", [
        "For ranches selling at the market and taking pre-orders online, Square's free store on the same POS account is the zero-friction option — with zero meat-specific features.",
      ]),
    ],
    myPick: [
      "Priced cuts/bundles/shares: Self-sown free, plus a BeefMaps listing for discovery.",
      "True catch-weight at volume: GrazeCart — it's the thing they're best at, and we'd rather be honest than win the wrong customer.",
    ],
    actionSteps: [
      "Write down your last 20 orders: priced items, or weighed-at-packing? That answer picks the platform.",
      "List on BeefMaps regardless — it's discovery, not a commitment.",
      "If priced items dominate, open a free Self-sown store and point the listing there.",
    ],
    faq: [
      {
        q: "Is there a free GrazeCart alternative?",
        a: "Self-sown is free with unlimited listings and no platform fees, and supports weight variants with per-variant pricing. It doesn't do true catch-weight charging — that's GrazeCart's paid specialty.",
      },
      {
        q: "What does GrazeCart cost above Starter?",
        a: "Not published — every tier above the $89/mo Starter requires talking to their sales team.",
      },
      {
        q: "Can I sell quarters and halves on Self-sown?",
        a: "Yes — list them with a deposit price, take the deposit online (card or Bitcoin), and settle the balance at pickup or delivery.",
      },
    ],
    related: [
      { href: "/vs/grazecart", label: "Self-sown vs GrazeCart, in depth" },
      {
        href: "/best/platform-for-beef-ranches",
        label: "Best platform for beef ranches",
      },
    ],
  },

  "facebook-marketplace": {
    kind: "alternatives",
    path: "/alternatives/facebook-marketplace",
    h1: "The best Facebook Marketplace alternatives for local food (2026)",
    metaTitle: "5 Best Facebook Marketplace Alternatives for Local Food (2026)",
    metaDescription:
      "Facebook Marketplace is free but it's a feed, not a store. The best alternatives for farm & food sellers who want real storefronts — honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Every local food seller's first storefront is Facebook Marketplace, because it's free and everyone's there. The search for alternatives starts with the first no-show, the fifth 'is this still available?', or the day a moderation bot removes your jam listing as contraband.",
      "These are the places to graduate to — while keeping Marketplace as free advertising.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        [
          "Self-sown (ours)",
          "A real store for your local buyers",
          "Free; 0% fees",
        ],
        ["Square Online", "Market vendors taking cards", "Free + processing"],
        ["Etsy", "Handmade goods with shipping", "~10% per sale"],
        ["Shopify", "Full online brand", "$39/mo + apps"],
        ["Barn2Door", "Established farms", "$119-299/mo + setup"],
      ],
    },
    sections: [
      {
        heading: "What you're actually missing",
        paragraphs: [
          "It's not features — it's permanence. A Marketplace listing is gone from the feed in days; there's no link to send a repeat customer, no cart, no record of what someone ordered last month, and no name they'll remember. The alternatives below are all ways to have a place instead of a post.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% fees", [
        "Self-sown is the same price as Marketplace (free) but it's a store: product pages, a cart, orders, a link you can print on a QR code, and a customer list that's yours. Payments settle directly to you — Bitcoin, cards, or the same Venmo/Zelle you're using in Messenger anyway.",
        "Unlike Marketplace, nothing gets auto-removed: your listings live on Nostr relays you choose, and food categories aren't gatekept. You follow your local laws; bots don't run your business.",
      ]),
      comp("square-online", "Standout", "Cards at the market + online", [
        "The free Square store pairs with the card reader you might already use at the booth. Smooth, familiar, and generic.",
      ]),
      comp("etsy", "Standout", "Shipped handmade goods", [
        "If your goods ship well — soap, candles, fiber — Etsy's buyer traffic beats a local feed. The fees (~10%+) are the price of that audience.",
      ]),
      comp("shopify", "Standout", "Building a real brand", [
        "The full DIY store. Overkill for most Marketplace sellers, but the ceiling is unlimited.",
      ]),
      comp("barn2door", "Standout", "Farm operations at scale", [
        "For farms that have clearly outgrown the feed — subscriptions, routing, wholesale — at farm-platform prices.",
      ]),
    ],
    myPick: [
      "Keep Marketplace for reach; open a free Self-sown store for the business. Put the store link in every Marketplace listing.",
      "When a buyer messages 'is this available?', the answer becomes a link where they can actually order it.",
    ],
    actionSteps: [
      "Open a free Self-sown stall and list what's currently in your Marketplace posts.",
      "Add the store link to every Marketplace listing and your Facebook page.",
      "Tell every repeat buyer the store exists — that's the whole migration.",
    ],
    faq: [
      {
        q: "Is there a free alternative to Facebook Marketplace?",
        a: "Self-sown (free store, no fees) and Square Online (free + processing). The difference from Marketplace: you get a permanent store instead of a disappearing post.",
      },
      {
        q: "Do I have to stop using Facebook?",
        a: "No — keep it for reach. The store is where the transaction happens; Facebook is how people discover it.",
      },
      {
        q: "Why do my food listings keep getting removed?",
        a: "Automated moderation misclassifies food categories (raw milk, preserves, live animals are frequent victims) and there's effectively no appeal. Self-sown doesn't gatekeep categories — your local laws are the rules.",
      },
    ],
    related: [
      {
        href: "/vs/facebook-marketplace",
        label: "Self-sown vs Facebook Marketplace, in depth",
      },
      {
        href: "/best/platform-for-selling-eggs-produce",
        label: "Best platform for selling eggs & produce",
      },
    ],
  },

  beefmaps: {
    kind: "alternatives",
    path: "/alternatives/beefmaps",
    h1: "The best BeefMaps alternatives for ranches (2026)",
    metaTitle: "5 Best BeefMaps Alternatives: Beef Directories & Stores (2026)",
    metaDescription:
      "BeefMaps is great for beef discovery but it's a directory, not a store. The best BeefMaps alternatives — including the store your listing should point to.",
    disclosure: DISCLOSURE,
    intro: [
      "BeefMaps does one job — connecting buyers with rancher-direct beef — and does it well. The reason ranches look for alternatives is structural: a directory sends you a buyer and then steps aside. No cart, no checkout, no order management.",
      "So this list splits into two kinds of tools: other ways to be found, and places to actually make the sale.",
    ],
    table: {
      columns: ["Option", "Kind", "Cost"],
      rows: [
        ["Self-sown (ours)", "Store (where the sale happens)", "Free; 0% fees"],
        ["GrazeCart", "Store, meat-specific", "$89/mo Starter"],
        ["Barn2Door", "Store, full farm platform", "$119-299/mo + setup"],
        ["Square Online", "Store, free checkout", "Free + processing"],
        ["Facebook Marketplace", "Discovery, local feed", "Free local"],
      ],
    },
    sections: [
      {
        heading: "Directory vs store is the whole question",
        paragraphs: [
          "A BeefMaps listing is a signpost: it tells a motivated beef buyer you exist. What happens next depends on where the signpost points. If it points at a phone number, you're taking orders by text message. The stores below are what the signpost should point at.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% fees", [
        "Self-sown is the free store your BeefMaps listing should point at: pages for every cut and bundle, deposits on quarters and halves, card or Bitcoin payments that settle straight to you, and order management — all at zero platform fees.",
        "It also sells everything else you raise — pork, eggs, tallow, jerky — in the same store, which a beef-only directory never will.",
      ]),
      comp("grazecart", "Standout", "Catch-weight meat fulfillment", [
        "The meat-specialist store: sell-by-weight with exact packed-weight charging, built by ranchers. Worth the $89/mo if catch-weight is your fulfillment model.",
      ]),
      comp("barn2door", "Standout", "Full farm operations", [
        "The everything platform for established farms: subscriptions, routing, onboarding. Priced accordingly.",
      ]),
      comp("square-online", "Standout", "Free, generic checkout", [
        "If you just need to take a card payment online for a quarter beef, Square's free store does it — with no beef-specific anything.",
      ]),
      comp("facebook-marketplace", "Standout", "Free local discovery", [
        "The other signpost: local reach for halves and quarters, free for pickup. Pair it with a store link or you're back to Messenger order management.",
      ]),
    ],
    myPick: [
      "Keep the BeefMaps listing — it's good discovery — and point it at a free Self-sown store.",
      "Add GrazeCart only if exact packed-weight charging becomes your bottleneck.",
    ],
    actionSteps: [
      "Open a free Self-sown store with your cuts, bundles, and share deposits.",
      "Update your BeefMaps listing to link to the store.",
      "Check where your last ten buyers came from — that tells you which signposts are working.",
    ],
    faq: [
      {
        q: "Is BeefMaps worth listing on?",
        a: "Yes — its buyers arrive already wanting ranch-direct beef, and the Rancher Direct Certified badge is real trust signal. Just make sure the listing points at a store where they can actually order.",
      },
      {
        q: "Does BeefMaps take a cut of sales?",
        a: "BeefMaps is a directory, not a checkout — there's no transaction to take a cut of. Check their site for current listing terms.",
      },
      {
        q: "What's the best free store to pair with BeefMaps?",
        a: "Self-sown: unlimited listings, no platform fees, and payments that settle directly to you. That's the combination we'd pick — and we build it, so weigh that.",
      },
    ],
    related: [
      { href: "/vs/beefmaps", label: "Self-sown vs BeefMaps, in depth" },
      {
        href: "/best/platform-for-beef-ranches",
        label: "Best platform for beef ranches",
      },
    ],
  },
};
