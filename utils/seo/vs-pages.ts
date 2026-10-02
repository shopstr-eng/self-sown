// Content for the /vs/<competitor> head-to-head pages. Honest by design:
// every page says plainly where the competitor wins.

import { COMPETITORS, SELFSOWN_PROFILE, type SeoPageContent } from "./model";

const DISCLOSURE =
  "Full disclosure: we build Self-sown, so yes, we're biased. We're going to tell you who each platform is actually right for — including when it isn't us.";

const vsTable = (
  competitorName: string,
  theirPrice: string,
  theirFees: string,
  theirOwnership: string,
  theirBestFor: string
) => ({
  columns: ["", "Self-sown", competitorName],
  rows: [
    ["Monthly cost", "Free (Herd $21/mo optional)", theirPrice],
    ["Transaction fees", "None from us, ever", theirFees],
    ["Payments", "Bitcoin (Lightning/Cashu), cards via Stripe or Square, Venmo/Zelle/cash", "Their processor, their rules"],
    ["Who owns the store", "You — listings live on Nostr relays you control", theirOwnership],
    ["Best for", SELFSOWN_PROFILE.bestFor, theirBestFor],
  ],
});

export const VS_PAGES: Record<string, SeoPageContent> = {
  shopify: {
    kind: "vs",
    path: "/vs/shopify",
    h1: "Self-sown vs Shopify (2026)",
    metaTitle: "Self-sown vs Shopify: Honest Comparison for Farm & Food Sellers",
    metaDescription:
      "Shopify starts at $39/mo plus apps. Self-sown is free with zero platform fees. An honest comparison for farmers and food producers — including where Shopify wins.",
    disclosure: DISCLOSURE,
    intro: [
      "Shopify is the default answer to \"how do I sell online,\" and for a lot of businesses it's the right one. But the question a farmer or food maker is really asking is narrower: how do I sell eggs, beef, jam, or soap to my community without paying rent on a store that's mostly empty?",
      `Here's the short version. ${COMPETITORS.shopify.price}. Self-sown is free — unlimited listings, no mandatory transaction fees, ever. Our optional Herd plan ($21/mo) adds custom domains, email flows, and shipping labels. The tradeoffs are real in both directions, so let's be specific.`,
    ],
    table: vsTable(
      "Shopify",
      "From $39/mo, before apps",
      "Card processing ~2.9% + 30c; 2% extra per sale off Shopify Payments",
      "Theirs — a policy change or frozen account ends your store",
      COMPETITORS.shopify.bestFor
    ),
    sections: [
      {
        heading: "Where Shopify honestly wins",
        paragraphs: [
          "Shopify's ecosystem is unmatched. Thousands of apps, hundreds of themes, 24/7 support, and a checkout that has been optimized by literally millions of merchants. If you're building a national brand with a warehouse, a fulfillment service, and a marketing team, Shopify will carry you further than we will — we won't pretend otherwise.",
          "Its app store also means an answer exists for almost any niche requirement. Need loyalty points, wholesale portals, and subscription bundles on day one? Someone built that.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Cost and ownership. A Shopify Basic store with a couple of necessary apps runs $60-100/mo before you sell a single dozen eggs. Self-sown is free: list everything, pay nothing to the platform. Payments go straight to you — Bitcoin over Lightning or Cashu, cards through your own Stripe or Square account, or manual fiat like Venmo, Cash App, and Zelle.",
          "And because Self-sown is built on Nostr, your listings and your customer relationships live on open relays, not in our database. We can't freeze your store, restrict your category, or hold your payout — and if you ever leave, your shop comes with you.",
        ],
      },
      {
        heading: "The question that actually matters",
        paragraphs: [
          "If your customers are local — a farmers market crowd, a CSA list, a neighborhood — you're paying Shopify for infrastructure you'll never use and getting nothing local in return. If you're shipping a brand nationally at volume, Shopify earns its fee. Pick based on which business you actually are.",
        ],
      },
    ],
    myPick: [
      "Selling local food or handmade goods to your community: start free on Self-sown. There's no monthly bill to justify, and migrating later is easy because your listings aren't locked in.",
      "Building a venture-scale CPG brand: use Shopify. That's what it's for, and it's excellent at it.",
    ],
    faq: [
      {
        q: "Can I move my Shopify store to Self-sown?",
        a: "Yes — there's a built-in Shopify migration that imports your products. Search the onboarding flow for \"migrate from Shopify.\"",
      },
      {
        q: "Does Self-sown have Shopify's app ecosystem?",
        a: "No, and that's deliberate. The features local sellers actually need — listings, orders, pickup/shipping, email flows, custom domains — are built in. If you need a loyalty-points gamification app, you want Shopify.",
      },
      {
        q: "Is Shopify ever cheaper than Self-sown?",
        a: "No. Shopify's floor is about $39/mo plus processing; Self-sown's floor is $0. The honest trade is features and ecosystem, not price.",
      },
      {
        q: "Can I use both?",
        a: "Plenty of producers do: Shopify for a national brand, Self-sown for the local market crowd. Because Self-sown costs nothing, there's no reason not to run both.",
      },
    ],
    related: [
      { href: "/alternatives/shopify", label: "Best Shopify alternatives" },
      { href: "/best/online-marketplace-for-farmers", label: "Best online marketplace for farmers" },
      { href: "/best/online-store-for-farmers-market-vendors", label: "Best online store for market vendors" },
    ],
  },

  etsy: {
    kind: "vs",
    path: "/vs/etsy",
    h1: "Self-sown vs Etsy (2026)",
    metaTitle: "Self-sown vs Etsy: Fees, Ownership & Honest Verdict (2026)",
    metaDescription:
      "Etsy takes $0.20 + 6.5% + processing on every sale, plus 12-15% on Offsite Ads. Self-sown charges nothing. An honest comparison for makers and food producers.",
    disclosure: DISCLOSURE,
    intro: [
      "Etsy is where the world goes to buy handmade soap, candles, and fiber art — and that buyer traffic is real and valuable. It's also where sellers go to watch fees stack up: $0.20 to list, 6.5% of the order (including shipping) as a transaction fee, around 3% + $0.25 for payment processing, and 12-15% if Etsy's Offsite Ads claim credit for the sale — mandatory once you pass $10k/yr.",
      "Self-sown charges none of that: free unlimited listings and no platform fees, with payments straight to you. What you give up is Etsy's built-in audience. Here's the honest version of both.",
    ],
    table: vsTable(
      "Etsy",
      "Free to start, then per-sale fees",
      "$0.20/listing + 6.5% transaction + ~3% + $0.25 processing; Offsite Ads 12-15%",
      "Theirs — suspensions are automated and appeals are slow",
      COMPETITORS.etsy.bestFor
    ),
    sections: [
      {
        heading: "Where Etsy honestly wins",
        paragraphs: [
          "Discovery. Millions of buyers type \"handmade candle\" into Etsy's search box every day, and a brand-new shop can get sales from that traffic with zero marketing. No other platform on this list — including ours — hands you that audience.",
          "It's also instant. Photos, a title, a price, and you're selling the same afternoon. If you make soap, candles, or fiber goods and have no audience at all, Etsy is the fastest first dollar in e-commerce.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Everything after the first sale. On Etsy, a $25 candle with $6 shipping pays roughly $0.20 listing + $2.02 transaction + $1.18 processing — over $3.40, or 11% — before Offsite Ads. On Self-sown the platform cut is $0. You keep the difference, or you price lower and win the local sale.",
          "You also keep the customer. Etsy owns the relationship — its emails, its marketplace, its rules. Self-sown listings live on open Nostr relays and your buyer list is yours, so the customer who found you once can buy from you forever without Etsy in the middle.",
        ],
      },
      {
        heading: "The pattern that actually works",
        paragraphs: [
          "Most successful makers we know treat Etsy as advertising: let its search traffic find new customers, then move repeat buyers to a channel you own. Self-sown is that channel — free enough that running both costs you nothing.",
        ],
      },
    ],
    myPick: [
      "No audience yet, selling handmade goods: open the Etsy shop. Pay the fees as your marketing budget.",
      "You have repeat buyers, a market booth, or any local following: put them on Self-sown and stop paying 11%+ for customers who already know your name.",
    ],
    faq: [
      {
        q: "Does Self-sown have Etsy's buyer traffic?",
        a: "No — that's Etsy's genuine advantage and the reason to use it. Self-sown is where you keep the customers you already have, fee-free.",
      },
      {
        q: "What are Etsy's total fees on a typical sale?",
        a: "Roughly 10-11% all-in on a $30 order (listing + 6.5% transaction + processing), before the optional-but-mandatory-over-$10k Offsite Ads fee of 12-15%.",
      },
      {
        q: "Can I sell food on Self-sown?",
        a: "Yes — baked goods, preserves, eggs, produce, meat, dairy, subject to your local cottage-food and health regulations. Self-sown doesn't gatekeep categories; the law in your area still applies to you.",
      },
      {
        q: "Is it really free?",
        a: "Yes. Unlimited listings, no platform transaction fees. If you take cards, Stripe or Square charge their standard processing fees; Bitcoin payments have no processing fee at all. The optional Herd plan ($21/mo) adds storefront customization, custom domains, email flows, and shipping labels.",
      },
    ],
    related: [
      { href: "/alternatives/etsy", label: "Best Etsy alternatives" },
      { href: "/best/marketplace-for-handmade-soap-candles", label: "Best marketplace for soap & candle makers" },
      { href: "/best/marketplace-for-wool-fiber", label: "Best marketplace for wool & fiber producers" },
    ],
  },

  barn2door: {
    kind: "vs",
    path: "/vs/barn2door",
    h1: "Self-sown vs Barn2Door (2026)",
    metaTitle: "Self-sown vs Barn2Door: Real Cost & Honest Comparison (2026)",
    metaDescription:
      "Barn2Door costs $119-299/mo plus a $399-599 setup fee. Self-sown is free with zero platform fees. An honest comparison for farms — including where Barn2Door wins.",
    disclosure: DISCLOSURE,
    intro: [
      "Barn2Door is the farm-specific incumbent, and parts of it are genuinely excellent. It's also one of the most expensive ways a small farm can sell online: Entrepreneur is $119/mo billed annually with a $399 setup fee, Business is $159/mo with a $499 setup fee, and Scale is $299/mo with a $599 setup fee. That's over $1,800 in year one before your first order.",
      "Self-sown is free — unlimited listings, no platform fees — with an optional $21/mo Herd plan for custom domains, email flows, and shipping labels. Here's the honest trade.",
    ],
    table: vsTable(
      "Barn2Door",
      "$119-299/mo billed annually + $399-599 setup",
      "Card processing on top; ~2.9% + 30c typical",
      "Theirs — it's a hosted platform you rent annually",
      COMPETITORS.barn2door.bestFor
    ),
    sections: [
      {
        heading: "Where Barn2Door honestly wins",
        paragraphs: [
          "Depth and hand-holding. Subscriptions, sell-by-weight, delivery routing, and pick-pack workflows are mature, and a real human migrates your products and trains you during onboarding. If you run a $300k/yr farm with delivery routes and you value \"someone else sets it up\" above all else, Barn2Door is built for you and priced accordingly.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Price — and it's not close. Barn2Door's entry tier costs more per year ($1,827) than most market farms spend on packaging. Self-sown is free, and even our fully-loaded Herd plan is $168/yr — about a tenth of Barn2Door's entry. For a farm testing online sales for the first time, that difference decides whether the experiment happens at all.",
          "Ownership too: Self-sown listings live on Nostr relays under your keys, so the store you build is yours. Barn2Door is a rented silo like the rest of the hosted platforms — leave, and you start over.",
        ],
      },
      {
        heading: "Who should pay Barn2Door",
        paragraphs: [
          "A farm already doing serious volume that wants white-glove migration and deep fulfillment features will get its money's worth. A farm that's pre-revenue online should not sign an annual $1,800 commitment to find out whether their customers will order on the internet. Start free, learn, then buy depth only if you outgrow it.",
        ],
      },
    ],
    myPick: [
      "First online store, or volume under ~$50k/yr online: Self-sown, free. Spend the $1,800 on feed.",
      "Established farm with complex delivery logistics and budget for onboarding: Barn2Door earns its fee.",
    ],
    faq: [
      {
        q: "What does Barn2Door actually cost in year one?",
        a: "Entrepreneur is $119/mo billed annually ($1,428) plus a $399 setup fee — $1,827 before processing fees. Business ($159/mo + $499) is $2,407; Scale ($299/mo + $599) is $4,187.",
      },
      {
        q: "Does Self-sown have sell-by-weight like Barn2Door?",
        a: "Self-sown supports weight and volume variants with per-variant pricing. Barn2Door's catch-weight fulfillment (charging the exact packed weight after the fact) is deeper — that's one of the things its fee buys.",
      },
      {
        q: "Can I switch from Barn2Door to Self-sown?",
        a: "Yes. You'll re-enter your products (there's no Barn2Door importer), but since Self-sown is free, most farms run both during the transition.",
      },
      {
        q: "Why is Self-sown so much cheaper — what's the catch?",
        a: "No catch, different architecture. Because listings live on open Nostr relays and payments go directly to you, we don't carry the infrastructure or the custody risk that subscription platforms price for. We make money on the optional Herd plan, not on your sales.",
      },
    ],
    related: [
      { href: "/alternatives/barn2door", label: "Best Barn2Door alternatives" },
      { href: "/best/online-marketplace-for-farmers", label: "Best online marketplace for farmers" },
      { href: "/best/ecommerce-for-raw-milk-dairies", label: "Best e-commerce for raw milk dairies" },
    ],
  },

  "square-online": {
    kind: "vs",
    path: "/vs/square-online",
    h1: "Self-sown vs Square Online (2026)",
    metaTitle: "Self-sown vs Square Online for Farm & Food Sellers (2026)",
    metaDescription:
      "Square Online's free plan takes ~2.9% + 30c online; Self-sown is free with zero platform fees and direct payments. Honest comparison, including where Square wins.",
    disclosure: DISCLOSURE,
    intro: [
      "Square Online is the best free plan in conventional e-commerce, full stop: $0/mo, pay only processing (about 2.9% + 30c online), and if you already take cards at the farmers market with a Square reader, your inventory and your online store live in the same account. That's a genuinely strong offer.",
      "Self-sown is also free — but with zero platform fees, direct payments (Bitcoin, your own Stripe or Square account, or cash apps), and a store you own on open Nostr relays. The difference isn't price; it's who holds the keys.",
    ],
    table: vsTable(
      "Square Online",
      "$0/mo free plan; Plus $49/mo; Premium $149/mo",
      "~2.9% + 30c online processing on the free plan",
      "Theirs — Square holds your funds and can hold them longer",
      COMPETITORS["square-online"].bestFor
    ),
    sections: [
      {
        heading: "Where Square honestly wins",
        paragraphs: [
          "Unified in-person and online selling. If your business is a market booth plus pre-orders, Square's card reader, inventory sync, and free online store are the smoothest package anywhere. Nobody on this list — us included — makes the Saturday-market-to-online-order loop that tight.",
          "It's also the fastest way to accept cards online for $0/mo. If you need that today and nothing else, take it.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Ownership and optionality. Square is a payments company with a terms of service: restricted categories get reviewed, funds get held, accounts get frozen — and food producers learn this at the worst possible time. Self-sown can't hold your money because we never touch it: Lightning and Cashu settle directly to you, and card payments run through your own Stripe or Square account.",
          "Self-sown also gives you a marketplace context Square doesn't have: discovery among local food buyers, a portable store on Nostr, and AI-agent-readable listings. And perversely, you can still use Square for what it's good at — connect your Square account as your card processor on Self-sown and keep the reader for the booth.",
        ],
      },
      {
        heading: "The honest read",
        paragraphs: [
          "Square Online is a free storefront bolted to a payment processor. Self-sown is a free marketplace you own that lets you bring any processor — including Square. If all you want is card checkout, both work. If you want the store itself to belong to you, only one does.",
        ],
      },
    ],
    myPick: [
      "Market booth + simple online pre-orders, already on Square: Square Online is fine, and you can add Self-sown free alongside it.",
      "Building a store you'll keep for years: Self-sown — same price (free), but the customer list and listings are yours.",
    ],
    faq: [
      {
        q: "Can I use Square as my card processor on Self-sown?",
        a: "Yes. Self-sown supports Square (and Stripe) as the card rail — you connect your own account, so the money never touches us.",
      },
      {
        q: "Which is actually cheaper?",
        a: "Both are $0/mo. Square Online charges ~2.9% + 30c online processing on the free plan; on Self-sown, card processing is whatever your own Stripe/Square account charges and Bitcoin payments have no processing fee at all.",
      },
      {
        q: "Does Square Online work for selling food?",
        a: "Yes, many food businesses use it — but food sellers are a restricted-adjacent category for payment processors, and account reviews and fund holds do happen. It's a risk to price in, not a reason to panic.",
      },
      {
        q: "Can I sell at the market and online with Self-sown?",
        a: "Self-sown handles the online side; for the in-person card reader you'd pair it with a Square device (same account you connect for online cards) or take cash/Venmo.",
      },
    ],
    related: [
      { href: "/alternatives/square-online", label: "Best Square Online alternatives" },
      { href: "/best/online-store-for-farmers-market-vendors", label: "Best online store for market vendors" },
      { href: "/best/ecommerce-platform-for-homesteaders", label: "Best e-commerce platform for homesteaders" },
    ],
  },

  "local-line": {
    kind: "vs",
    path: "/vs/local-line",
    h1: "Self-sown vs Local Line (2026)",
    metaTitle: "Self-sown vs Local Line: Honest Comparison for Farms (2026)",
    metaDescription:
      "Local Line starts at $79/mo billed annually plus processing. Self-sown is free with zero platform fees. Honest comparison — including where Local Line wins for food hubs.",
    disclosure: DISCLOSURE,
    intro: [
      "Local Line calls itself the operating system for farms and food hubs, and on the B2B side it earns the title: wholesale price lists, multi-producer food-hub aggregation, and subscription boxes are genuinely strong. It starts at $79/mo billed annually — about $950/yr — plus 2.9% + 30c processing.",
      "Self-sown is free, with zero platform fees and direct payments. Different tools for different operations — here's which is which.",
    ],
    table: vsTable(
      "Local Line",
      "From $79/mo billed annually",
      "2.9% + 30c card processing",
      "Theirs — hosted platform, annual commitment",
      COMPETITORS["local-line"].bestFor
    ),
    sections: [
      {
        heading: "Where Local Line honestly wins",
        paragraphs: [
          "Wholesale and food hubs. If you sell to restaurants and grocers on separate price lists, or you're a hub aggregating twenty producers into one storefront, Local Line's tooling is the deepest on this list and the monthly fee is a rounding error against a wholesale book. Nothing else here — including us — matches that.",
          "Its subscription-box machinery is also built-in and mature, which matters if recurring boxes are your whole business.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Everything about starting. Local Line's entry is ~$950/yr committed annually; Self-sown is $0 with unlimited listings. For a farm selling direct to consumers — eggs, produce, meat, baked goods — there's no Local Line feature that justifies that gap at the start.",
          "And again, ownership: Self-sown stores live on Nostr relays under your keys and payments settle directly to you. Local Line is a rented platform like the others.",
        ],
      },
      {
        heading: "The dividing line",
        paragraphs: [
          "Consumers vs wholesale. Direct-to-consumer farm store: Self-sown, free. Wholesale book or food hub with real B2B complexity: Local Line earns its fee. Some farms end up running both — free consumer storefront here, wholesale there.",
        ],
      },
    ],
    myPick: [
      "Selling direct to eaters: Self-sown, free, and only upgrade to Herd ($21/mo) if the extras pay for themselves.",
      "Selling to restaurants, grocers, or running a multi-farm hub: Local Line is worth the subscription.",
    ],
    faq: [
      {
        q: "What does Local Line cost?",
        a: "From $79/mo billed annually (roughly $950/yr) plus 2.9% + 30c card processing, with higher tiers for bigger operations.",
      },
      {
        q: "Does Self-sown do subscriptions or CSA boxes?",
        a: "Recurring-box management is not Self-sown's strength today — Local Line and Barn2Door are deeper there. Self-sown handles the storefront, orders, and payments; many CSA farms pair it with a simple signup list.",
      },
      {
        q: "Can I run wholesale on Self-sown?",
        a: "You can list anything and take orders, but per-customer wholesale price lists and hub aggregation are Local Line's home turf. Be honest with yourself about which business you're running.",
      },
      {
        q: "Is Self-sown really free for unlimited products?",
        a: "Yes. Unlimited listings, no platform fees, no annual commitment. The optional Herd plan ($21/mo) adds custom domains, email flows, and shipping labels.",
      },
    ],
    related: [
      { href: "/alternatives/local-line", label: "Best Local Line alternatives" },
      { href: "/best/online-marketplace-for-farmers", label: "Best online marketplace for farmers" },
      { href: "/best/platform-for-selling-eggs-produce", label: "Best platform for selling eggs & produce" },
    ],
  },

  grazecart: {
    kind: "vs",
    path: "/vs/grazecart",
    h1: "Self-sown vs GrazeCart (2026)",
    metaTitle: "Self-sown vs GrazeCart for Ranches: Honest Comparison (2026)",
    metaDescription:
      "GrazeCart starts at $89/mo for sell-by-weight meat e-commerce. Self-sown is free with zero platform fees. Honest comparison for ranches — including where GrazeCart wins.",
    disclosure: DISCLOSURE,
    intro: [
      "GrazeCart was built by the Seven Sons ranch team, and it shows: sell-by-weight with catch-weight fulfillment, delivery zones, and pickup management designed by people who have actually packed a box of frozen steaks. Starter is $89/mo — $1,068/yr — and every tier above that hides behind a \"talk with an expert\" button.",
      "Self-sown is free, with zero platform fees and direct payments in Bitcoin, cards, or cash apps. If you sell meat, this is the most honest comparison on this site.",
    ],
    table: vsTable(
      "GrazeCart",
      "$89/mo Starter; higher tiers unpublished",
      "Card processing on top of the subscription",
      "Theirs — hosted platform you rent",
      COMPETITORS.grazecart.bestFor
    ),
    sections: [
      {
        heading: "Where GrazeCart honestly wins",
        paragraphs: [
          "Catch-weight fulfillment. If you sell a customer \"a ribeye, about 1.2 lb\" and charge the exact packed weight at fulfillment, GrazeCart's workflow is the best in the business. Self-sown supports weight variants with per-variant prices, but charging the true weight after packing is GrazeCart's home turf — if that's the core of your operation, take it seriously.",
          "The ranch pedigree is real too: the defaults, from cut lists to delivery routes, assume a working ranch rather than a generic store.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Price and breadth. $1,068/yr is a real cost for a ranch testing direct sales, and Self-sown is free with unlimited listings. Self-sown also isn't meat-shaped: the same store can carry your beef, your neighbor's honey, your eggs, and your tallow candles.",
          "Payments settle directly to you — Bitcoin over Lightning/Cashu with no processing fee, or cards through your own Stripe/Square account — and the store lives on Nostr relays you control. And for beef-specific discovery, pair it with a BeefMaps directory listing; see the comparison at /vs/beefmaps.",
        ],
      },
      {
        heading: "The honest read for ranchers",
        paragraphs: [
          "Decide by fulfillment style. True catch-weight e-commerce at volume: GrazeCart is purpose-built and worth paying for. Pre-priced cuts, bundles, and quarters/halves by deposit: Self-sown does everything you need at $0 — and you can put the saved $1,068 toward a freezer.",
        ],
      },
    ],
    myPick: [
      "Selling by exact packed weight at scale: GrazeCart, and don't let us talk you out of it.",
      "Selling priced cuts, bundles, shares, or a mixed ranch store: Self-sown, free, plus a BeefMaps listing for discovery.",
    ],
    faq: [
      {
        q: "Does Self-sown support sell-by-weight?",
        a: "Yes, as weight variants with per-variant pricing (e.g. 1 lb / 2 lb / 5 lb). GrazeCart's catch-weight flow — authorizing an estimated weight and charging the exact packed weight — is deeper.",
      },
      {
        q: "What does GrazeCart cost?",
        a: "The Starter plan is published at $89/mo ($1,068/yr). Higher tiers aren't published — you have to talk to their sales team.",
      },
      {
        q: "Can I take deposits for quarters and halves on Self-sown?",
        a: "Yes — list the share with a deposit price and settle the balance however you like (many ranches use manual invoice or Venmo/Zelle at pickup).",
      },
      {
        q: "Is GrazeCart or Self-sown better for a brand-new ranch store?",
        a: "Self-sown, because it's free — learn whether your customers will order online before committing $1,000+/yr. If you grow into catch-weight fulfillment at volume, GrazeCart will still be there.",
      },
    ],
    related: [
      { href: "/alternatives/grazecart", label: "Best GrazeCart alternatives" },
      { href: "/vs/beefmaps", label: "Self-sown vs BeefMaps" },
      { href: "/best/platform-for-beef-ranches", label: "Best platform for beef ranches" },
    ],
  },

  "facebook-marketplace": {
    kind: "vs",
    path: "/vs/facebook-marketplace",
    h1: "Self-sown vs Facebook Marketplace (2026)",
    metaTitle: "Self-sown vs Facebook Marketplace for Local Food (2026)",
    metaDescription:
      "Facebook Marketplace is free for local pickup but has no store, no brand, and moderation bots that flag jam. Honest comparison with Self-sown.",
    disclosure: DISCLOSURE,
    intro: [
      "Facebook Marketplace is where a huge share of local food actually changes hands — eggs, calves, garden surplus — because it's free for local pickup and every buyer in your county is already scrolling it. Shipped orders carry a 10% selling fee ($0.80 minimum), but for porch pickup it costs nothing.",
      "So why does anyone need anything else? Because Marketplace is a feed, not a store. Here's the honest comparison.",
    ],
    table: vsTable(
      "Facebook Marketplace",
      "Free local pickup; 10% fee on shipped orders",
      "10% selling fee on shipped orders ($0.80 min)",
      "Nobody — your listings drown in the feed and bots moderate them",
      COMPETITORS["facebook-marketplace"].bestFor
    ),
    sections: [
      {
        heading: "Where Facebook Marketplace honestly wins",
        paragraphs: [
          "Reach, for free. No platform on earth puts \"fresh eggs, $5/dozen\" in front of more local people faster. For moving surplus — a bumper crop, a pig ready sooner than planned, end-of-market flats — nothing beats it, and we use it ourselves.",
          "There's no setup either: if you have a Facebook account you have a storefront, sort of.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Everything that makes a business a business. Marketplace has no product pages, no cart, no reorder link, no customer list, and no brand — every sale starts from zero in Messenger, and half your time goes to haggling and no-shows. Self-sown gives you a real storefront with a link you can put on a QR code at your booth, in your farm's Instagram bio, or on the egg carton itself.",
          "Then there's moderation. Food sellers know the drill: a listing for raw milk, jam, or live birds gets auto-flagged by bots that can't tell cottage food from contraband, and there's nobody to appeal to. Self-sown doesn't gatekeep categories — you follow your local laws, and your listings stay up on relays you choose.",
        ],
      },
      {
        heading: "The pattern that works",
        paragraphs: [
          "Use the feed for discovery, the store for the relationship. Post on Marketplace, and put your Self-sown store link in every listing and every reply. The first dozen eggs sell on Facebook; every dozen after that sells in your own store with zero fees and zero bots.",
        ],
      },
    ],
    myPick: [
      "One-off surplus and brand-new sellers: Facebook Marketplace, today, free.",
      "Anyone with repeat buyers: a Self-sown store they can bookmark, with Marketplace as your free advertising.",
    ],
    faq: [
      {
        q: "Is Facebook Marketplace free for selling food?",
        a: "For local pickup, yes. Shipped orders through checkout carry a 10% selling fee ($0.80 minimum). The bigger cost is hidden: no store, no customer list, and moderation bots that flag food listings.",
      },
      {
        q: "Can Self-sown replace my farm's Facebook page?",
        a: "It replaces the selling part — storefront, orders, payments. Keep Facebook for what it's good at: reaching local people and pointing them at your store.",
      },
      {
        q: "Why do food listings get removed from Facebook?",
        a: "Automated moderation. Categories like raw milk, alcohol-adjacent preserves, and live animals trip classifiers, and enforcement is inconsistent and effectively unappealable.",
      },
      {
        q: "Does Self-sown have the same local reach?",
        a: "Not by itself — that's Facebook's genuine edge. The play is to harvest Facebook's reach and own the relationship in your own store.",
      },
    ],
    related: [
      { href: "/alternatives/facebook-marketplace", label: "Best Facebook Marketplace alternatives" },
      { href: "/best/platform-for-selling-eggs-produce", label: "Best platform for selling eggs & produce" },
      { href: "/best/ecommerce-platform-for-homesteaders", label: "Best e-commerce platform for homesteaders" },
    ],
  },

  beefmaps: {
    kind: "vs",
    path: "/vs/beefmaps",
    h1: "Self-sown vs BeefMaps (2026)",
    metaTitle: "Self-sown vs BeefMaps: Directory vs Store for Beef Ranches (2026)",
    metaDescription:
      "BeefMaps is a rancher-direct beef discovery directory; Self-sown is the free store where the sale actually happens. Honest comparison — and why you probably want both.",
    disclosure: DISCLOSURE,
    intro: [
      "This comparison is different from the others, because BeefMaps isn't really a competitor — it's a directory. BeefMaps maintains a map of Rancher Direct Certified independent ranches, so buyers hunting a quarter or half of beef straight from the ranch can find you. It's discovery, done well, for beef only.",
      "What BeefMaps doesn't do is the sale: no cart, no payments, no order management. That makes the honest framing less \"versus\" and more \"which job are you hiring for\" — and most ranches should hire both.",
    ],
    table: vsTable(
      "BeefMaps",
      "Directory listing — see their site for terms",
      "n/a — no checkout, so no transaction fees",
      "A listing on their map; your sale happens elsewhere",
      COMPETITORS.beefmaps.bestFor
    ),
    sections: [
      {
        heading: "Where BeefMaps honestly wins",
        paragraphs: [
          "Targeted discovery. A buyer on BeefMaps is already looking for ranch-direct beef — quarters, halves, custom cuts — which is the highest-intent traffic a ranch can get. The Rancher Direct Certified badge carries real weight with that crowd, and the directory spans ranches across the country.",
          "If you sell beef, getting listed is close to a no-brainer regardless of what else you use.",
        ],
      },
      {
        heading: "Where Self-sown wins",
        paragraphs: [
          "Everything after \"a buyer found you.\" Self-sown is the store: product pages for your cuts and bundles, deposits on quarters and halves, card or Bitcoin payments that settle directly to you, order management, and zero platform fees. It's also not beef-only — the same store carries your pork, eggs, tallow, and jerky.",
          "And because Self-sown stores live on open Nostr relays, the customer list you build is yours — a buyer who found you on a map becomes a relationship no directory controls.",
        ],
      },
      {
        heading: "Why the answer is both",
        paragraphs: [
          "Directory plus store is the classic ranch stack: BeefMaps sends the buyer, Self-sown closes the sale. The alternative — a BeefMaps listing pointing at a phone number and a paper form — leaks the high-intent buyers the directory worked to find you.",
        ],
      },
    ],
    myPick: [
      "List on BeefMaps for discovery, and point the listing at a free Self-sown store so the buyer can actually order.",
      "If you can only do one: Self-sown, because a store without a directory can still be found — a directory listing without a store can't sell.",
    ],
    faq: [
      {
        q: "Is BeefMaps a marketplace?",
        a: "No — it's a discovery directory of Rancher Direct Certified ranches. Buyers find you there; the transaction happens wherever your store lives.",
      },
      {
        q: "Can BeefMaps link to my Self-sown store?",
        a: "That's the recommended setup: the directory listing points at your store URL, where the buyer browses cuts, pays a deposit, and checks out.",
      },
      {
        q: "Does Self-sown have ranch discovery built in?",
        a: "The Self-sown marketplace is browsable and AI-agent-readable, but it isn't beef-specific — BeefMaps' focused audience is its genuine edge. Pair them.",
      },
      {
        q: "What if I sell more than beef?",
        a: "BeefMaps won't list your pork, eggs, or soap. Self-sown will, in the same store, for free.",
      },
    ],
    related: [
      { href: "/alternatives/beefmaps", label: "Best BeefMaps alternatives" },
      { href: "/best/platform-for-beef-ranches", label: "Best platform for beef ranches" },
      { href: "/vs/grazecart", label: "Self-sown vs GrazeCart" },
    ],
  },
};
