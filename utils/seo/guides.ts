// Content for the 10 /best/<slug> listicle guides, modeled on the
// rhinovoice.app/best/* layout: disclosure, comparison table, narrative,
// numbered picks, "our pick", action steps, FAQ. Honest by design — the
// top pick is NOT always ours.

import {
  COMPETITORS,
  SELFSOWN_PROFILE,
  type CompetitorSlug,
  type SeoPageContent,
  type SeoPick,
} from "./model";

const DISCLOSURE =
  "Full disclosure: we make one of these. So yes, we're biased — and we've still ranked competitors first where they're genuinely the better tool. Read the \"best for\" lines before the names.";

const us = (factValue: string, paragraphs: string[]): SeoPick => ({
  name: `${SELFSOWN_PROFILE.name} (ours)`,
  bestFor: SELFSOWN_PROFILE.bestFor,
  price: SELFSOWN_PROFILE.price,
  fact: { label: "Platform fees", value: factValue },
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

export const GUIDES: Record<string, SeoPageContent> = {
  "online-marketplace-for-farmers": {
    kind: "best",
    path: "/best/online-marketplace-for-farmers",
    h1: "The best online marketplace for farmers (2026)",
    metaTitle: "Best Online Marketplace for Farmers: 5 Honest Picks (2026)",
    metaDescription:
      "The best online marketplaces and stores for farmers in 2026 — from free (Self-sown) to full-service (Barn2Door). Real prices, honest tradeoffs.",
    disclosure: DISCLOSURE,
    intro: [
      "\"Online marketplace for farmers\" covers everything from a Facebook post about eggs to a $299/mo farm platform. What matters is matching the tool to the size of the experiment you're running — and knowing who owns your customer list at the end.",
      "Here are the five we'd actually consider, with real prices.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Self-sown (ours)", "Selling direct with zero fees and full ownership", "Free; Herd $21/mo optional"],
        ["Barn2Door", "Established farms wanting full-service", "$119-299/mo + $399-599 setup"],
        ["Local Line", "Wholesale & food hubs", "From $79/mo billed annually"],
        ["Square Online", "Market booth + online pre-orders", "Free + ~2.9% + 30c"],
        ["Facebook Marketplace", "Free local reach", "Free local; 10% shipped"],
      ],
    },
    sections: [
      {
        heading: "Why the fee structure matters more than the sticker",
        paragraphs: [
          "Farm margins run 10-20%. A platform taking 10% of each order (marketplace fees) or $1,800/yr upfront (farm platforms) isn't a cost line — it's your profit line. The options below split into three honest camps: free-and-yours, expensive-and-deep, and free-but-not-a-store.",
        ],
      },
      {
        heading: "Marketplace vs store",
        paragraphs: [
          "A true marketplace brings buyers to you (Facebook, and the Self-sown marketplace). A store gives you a place to send buyers you already have. Most farms need the store first and the marketplace second — be suspicious of any platform whose pitch is traffic but whose product is a checkout.",
        ],
      },
    ],
    picks: [
      us("None — free listings, 0% platform fees", [
        "Self-sown is the free marketplace-plus-store built for exactly this: unlimited listings, a browsable local-food marketplace, order management, and payments that settle directly to you — Bitcoin (Lightning/Cashu), cards through your own Stripe or Square account, or Venmo/Zelle/cash.",
        "Because listings live on open Nostr relays, the store and the customer list are yours: no frozen accounts, no category bans, no take-it-or-leave-it terms updates. Custom domains, email flows, and shipping labels sit on the optional Herd plan ($21/mo).",
      ]),
      comp("barn2door", "Dealbreaker for some", "$1,827 minimum in year one", [
        "The full-service incumbent: subscriptions, sell-by-weight, delivery routing, and humans who migrate your products and train you. For an established farm doing real online volume, it's the depth play.",
        "For a farm's first online season, the annual $119-299/mo commitment plus setup fee is a heavy bet to place before you know your customers will order online.",
      ]),
      comp("local-line", "Dealbreaker for some", "~$950/yr, annual billing", [
        "The wholesale specialist: restaurant/grocer price lists and multi-farm food-hub tooling that nothing else here matches. If B2B is your business, this is the one.",
        "For direct-to-consumer sales you're paying for machinery you won't use.",
      ]),
      comp("square-online", "Dealbreaker for some", "A store with no discovery", [
        "Free online ordering on the same account as your market card reader — the smoothest booth-to-online loop available.",
        "It's a checkout, not a marketplace: no farm context, no discovery, and the money and customers live in Square's ecosystem.",
      ]),
      comp("facebook-marketplace", "Dealbreaker for some", "No store at all", [
        "The biggest local audience on earth, free for porch pickup. Every farmer should use it — as advertising.",
        "As a store it fails completely: no pages, no cart, no reorders, and moderation bots that flag food listings. Harvest the reach; keep the business elsewhere.",
      ]),
    ],
    myPick: [
      "Default for most farms: Self-sown free, with Facebook Marketplace as your free billboard pointing at it.",
      "If you're already at serious online volume and want white-glove everything: Barn2Door. If wholesale is the business: Local Line.",
    ],
    actionSteps: [
      "List your ten best sellers on Self-sown (free) — an afternoon, not a project.",
      "Post your store link wherever your customers already are: Facebook, the market booth, the egg carton.",
      "Only look at paid platforms when a specific missing feature — not a vague feeling — demands it.",
    ],
    faq: [
      {
        q: "What is the cheapest way for a farmer to sell online?",
        a: "Self-sown (free, no platform fees) or Square Online (free + ~2.9% processing). Facebook Marketplace is free for local pickup but isn't a store.",
      },
      {
        q: "Is Barn2Door worth it for a small farm?",
        a: "Usually not — $1,800+ in year one is hard to justify below meaningful online volume. Start free; buy depth when a specific feature demands it.",
      },
      {
        q: "Can I take card payments without a subscription?",
        a: "Yes. Self-sown connects your own Stripe or Square account (their standard processing applies), and Bitcoin payments over Lightning/Cashu have no processing fee at all.",
      },
    ],
    related: [
      { href: "/vs/shopify", label: "Self-sown vs Shopify" },
      { href: "/vs/barn2door", label: "Self-sown vs Barn2Door" },
      { href: "/alternatives/barn2door", label: "Barn2Door alternatives" },
    ],
  },

  "ecommerce-platform-for-homesteaders": {
    kind: "best",
    path: "/best/ecommerce-platform-for-homesteaders",
    h1: "The best e-commerce platform for homesteaders (2026)",
    metaTitle: "Best E-commerce Platform for Homesteaders: 5 Picks (2026)",
    metaDescription:
      "Homesteads sell a bit of everything — eggs, soap, seedlings, preserves. The best e-commerce platforms for homesteaders in 2026, honestly compared with real prices.",
    disclosure: DISCLOSURE,
    intro: [
      "A homestead store isn't like other stores. It sells a dozen categories at once — eggs this week, soap next month, tomato seedlings in spring — in small, irregular quantities, to people who mostly live nearby. Platforms built for single-product brands fit this badly.",
      "Here's what actually fits, with real prices.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Self-sown (ours)", "Mixed homestead goods, zero fees", "Free; Herd $21/mo optional"],
        ["Square Online", "Homesteads already using Square at markets", "Free + ~2.9% + 30c"],
        ["Etsy", "The handmade half of the homestead", "~10% per sale"],
        ["Facebook Marketplace", "Moving surplus locally, fast", "Free local; 10% shipped"],
        ["Shopify", "Homesteads becoming brands", "$39/mo + apps"],
      ],
    },
    sections: [
      {
        heading: "Why irregular inventory breaks most platforms",
        paragraphs: [
          "Subscription platforms charge you in February for a store that's empty until April. Per-sale fee platforms eat irregular small orders alive — a $5 dozen eggs can't absorb Etsy's stacked fees. The right homestead platform costs nothing when you're not selling and everything you list stays up until it sells.",
        ],
      },
    ],
    picks: [
      us("None — list everything, pay nothing", [
        "Self-sown matches the homestead shape: unlimited free listings across every category (food, plants, soap, fiber, crafts), no monthly fee in the off-season, and no per-sale platform cut on a $5 carton of eggs.",
        "Payments fit homestead reality too: Bitcoin if your buyers are into it, cards via your own Stripe/Square, or just Venmo/Zelle/cash — and the store lives on open Nostr relays, so nobody moderates your raw-honey listing into oblivion.",
      ]),
      comp("square-online", "Watch for", "Nothing farm/homestead-specific", [
        "Free online ordering that shares inventory with a market card reader. If you already take Square at the market, adding the online store costs nothing.",
        "The store is generic and discovery is zero — it's a cash register with a URL.",
      ]),
      comp("etsy", "Watch for", "Fees on small orders hurt most", [
        "For the handmade side — soap, candles, fiber — Etsy's buyer traffic is real and worth paying for while you build an audience.",
        "On a $6 bar of soap the stacked fees are brutal, and food categories are restricted. It's a channel for the craft shelf, not the whole homestead.",
      ]),
      comp("facebook-marketplace", "Watch for", "No permanence", [
        "The fastest way to move surplus: a glut of zucchini, fifty extra chicks, end-of-season firewood. Free, local, immediate.",
        "Everything is a one-off. No store, no repeat-customer flow, no record of anything.",
      ]),
      comp("shopify", "Watch for", "$39/mo in the off-season too", [
        "If the homestead is becoming a brand — content, email list, national shipping — Shopify is the conventional platform for that leap.",
        "Most homesteads aren't there yet, and paying $470/yr to find out is expensive tuition.",
      ]),
    ],
    myPick: [
      "Self-sown free for the whole mixed store, Etsy for the craft shelf if you need its traffic, Facebook for surplus.",
      "That stack costs $0/mo and covers everything a homestead actually sells.",
    ],
    actionSteps: [
      "Open a free Self-sown stall and list one item from each category you sell.",
      "Print a QR code to the store for your market table and egg cartons.",
      "Add Etsy only for the categories where its search traffic exists (soap, candles, fiber).",
    ],
    faq: [
      {
        q: "What's the best free e-commerce platform for a homestead?",
        a: "Self-sown — free unlimited listings across every category with no platform fees. Square Online is also free but takes ~2.9% + 30c and is a generic checkout rather than a marketplace.",
      },
      {
        q: "Can I sell both food and crafts in one store?",
        a: "On Self-sown, yes — categories aren't restricted. Etsy restricts many food categories; Shopify allows both but charges monthly.",
      },
      {
        q: "Do I need a business license to sell homestead goods online?",
        a: "Platform choice doesn't change the law: cottage-food, egg, and dairy rules are set by your state/county and apply wherever you sell. Check yours before the first sale.",
      },
    ],
    related: [
      { href: "/vs/etsy", label: "Self-sown vs Etsy" },
      { href: "/best/platform-for-selling-eggs-produce", label: "Best platform for eggs & produce" },
      { href: "/best/platform-for-selling-honey-preserves", label: "Best platform for honey & preserves" },
    ],
  },

  "platform-for-beef-ranches": {
    kind: "best",
    path: "/best/platform-for-beef-ranches",
    h1: "The best platform for beef ranches selling direct (2026)",
    metaTitle: "Best Platform for Beef Ranches Selling Direct: 5 Picks (2026)",
    metaDescription:
      "The best platforms for ranches selling beef direct in 2026 — GrazeCart, Self-sown, BeefMaps, Barn2Door, Square. Real prices, honest tradeoffs.",
    disclosure: DISCLOSURE,
    intro: [
      "Selling beef direct is a specific job: quarters and halves by deposit, priced cuts, bundle boxes, maybe catch-weight fulfillment — to buyers who are often specifically hunting ranch-direct meat. The right stack is usually a directory plus a store, not one magic platform.",
      "Here are the five tools worth considering, with the honest caveat that the best one depends on how you pack orders.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["GrazeCart", "True catch-weight fulfillment", "$89/mo Starter"],
        ["Self-sown (ours)", "Priced cuts, bundles & share deposits, free", "Free; Herd $21/mo optional"],
        ["BeefMaps", "Being found by beef buyers", "Directory listing"],
        ["Barn2Door", "Full-service farm platform", "$119-299/mo + setup"],
        ["Square Online", "Simple free checkout", "Free + ~2.9% + 30c"],
      ],
    },
    sections: [
      {
        heading: "The catch-weight decision",
        paragraphs: [
          "One question picks your platform: when you sell a ribeye, do you charge a listed price, or the exact packed weight after the fact? Catch-weight (the second one) is GrazeCart's entire reason to exist, and if that's your fulfillment model you should stop reading and call them.",
          "If you sell priced cuts, curated bundles, and shares by deposit — most ranches starting direct sales — every option below handles it, so the decision becomes cost and ownership.",
        ],
      },
      {
        heading: "Discovery is a separate problem",
        paragraphs: [
          "No store platform brings you beef buyers. BeefMaps does — a directory of rancher-direct beef where buyers arrive already wanting a quarter or half, with a certification badge that carries trust. Budget for a listing there whatever store you pick.",
        ],
      },
    ],
    picks: [
      comp("grazecart", "Dealbreaker for some", "$1,068/yr, meat-shaped only", [
        "Built by the Seven Sons ranch team and it shows: sell-by-weight with exact packed-weight charging, delivery zones, and pickup management designed by people who have packed frozen beef for a living.",
        "The price is real ($89/mo Starter, higher tiers unpublished) and the design is meat-only — your eggs and tallow candles don't fit. For catch-weight at volume, it's the right tool and we're not going to pretend otherwise.",
      ]),
      us("None — free listings, 0% platform fees", [
        "For the way most ranches actually start — priced cuts, bundle boxes, quarters/halves with an online deposit — Self-sown does the whole job at $0. Weight variants with per-variant pricing are built in, and payments settle directly to you: Bitcoin (Lightning/Cashu), cards via your own Stripe/Square, or cash apps.",
        "The store carries your non-beef products too, and because listings live on open Nostr relays, no processor's category review can freeze your beef money. Honest gap: no catch-weight charging.",
      ]),
      comp("beefmaps", "Watch for", "Directory only — no checkout", [
        "The discovery half of the stack: a map of Rancher Direct Certified ranches that beef buyers actually browse. A listing is close to a no-brainer.",
        "It sends you a buyer and steps aside — no cart, no payments, no orders. Point the listing at a real store or you're taking orders by text message.",
      ]),
      comp("barn2door", "Watch for", "$1,827+ year one", [
        "The full farm platform: subscriptions, routing, sell-by-weight support, white-glove onboarding. For a ranch at serious volume it can pay for itself.",
        "For a first direct-sales season it's an expensive way to learn.",
      ]),
      comp("square-online", "Watch for", "Generic checkout", [
        "Free online card payments on the same account as a market reader. Fine for taking a deposit on a half; offers nothing beef-specific.",
      ]),
    ],
    myPick: [
      "Catch-weight at volume: GrazeCart — we compete for your business, not against your fulfillment model.",
      "Everyone else: a free Self-sown store pointed at by a BeefMaps listing. Total platform cost: $0.",
    ],
    actionSteps: [
      "Decide priced-cuts vs catch-weight by looking at your last 20 orders.",
      "List on BeefMaps and open a free Self-sown store; link them together.",
      "Take share deposits online this season instead of by check — you'll never go back.",
    ],
    faq: [
      {
        q: "What's the best free platform for selling beef direct?",
        a: "Self-sown: unlimited listings, share deposits, weight variants, direct payments, and no platform fees. Pair it with a BeefMaps listing for discovery.",
      },
      {
        q: "Do I need catch-weight software?",
        a: "Only if you charge exact packed weights at fulfillment. If you sell priced cuts, bundles, and shares, per-variant pricing covers it and you can skip the $89/mo.",
      },
      {
        q: "Can I take deposits for quarters and halves online?",
        a: "Yes — Self-sown (free) or Square Online both handle a deposit listing with the balance settled at pickup.",
      },
    ],
    related: [
      { href: "/vs/grazecart", label: "Self-sown vs GrazeCart" },
      { href: "/vs/beefmaps", label: "Self-sown vs BeefMaps" },
      { href: "/alternatives/grazecart", label: "GrazeCart alternatives" },
    ],
  },

  "online-store-for-farmers-market-vendors": {
    kind: "best",
    path: "/best/online-store-for-farmers-market-vendors",
    h1: "The best online store for farmers market vendors (2026)",
    metaTitle: "Best Online Store for Farmers Market Vendors: 5 Picks (2026)",
    metaDescription:
      "Pre-orders, market pickup, and the booth-to-online loop. The best online stores for farmers market vendors in 2026 — real prices, honest tradeoffs.",
    disclosure: DISCLOSURE,
    intro: [
      "The market vendor's online store has one job the others don't: the pre-order. Let customers order Thursday, pick up Saturday at the booth — no queue, no sold-out disappointment, no cash handling. Everything else is secondary.",
      "Here are the five platforms that handle the booth-to-online loop, honestly ranked.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Square Online", "Unifying booth POS + online pre-orders", "Free + ~2.9% + 30c"],
        ["Self-sown (ours)", "Zero-fee pre-orders & a store you own", "Free; Herd $21/mo optional"],
        ["Shopify", "Vendors becoming retail brands", "$39/mo + apps"],
        ["Facebook Marketplace", "Announcing what you're bringing", "Free local"],
        ["Local Line", "Vendors adding wholesale", "From $79/mo"],
      ],
    },
    sections: [
      {
        heading: "The POS question decides a lot",
        paragraphs: [
          "If you take cards at the booth, your card reader's ecosystem has a gravitational pull: Square sellers get a free online store on the same inventory, which is a genuinely good deal. Every other platform means managing two systems — which is fine, because a pre-order store and a card reader don't actually need to share anything but a product list.",
        ],
      },
    ],
    picks: [
      comp("square-online", "The catch", "Your store lives in Square's ecosystem", [
        "The honest top pick for pure convenience: free online ordering on the same account and inventory as your market card reader. Pre-orders for market pickup work out of the box, and there is nothing to integrate.",
        "The trade: a generic store with no local-food discovery, ~2.9% + 30c online processing, and a platform that can hold your funds when its risk bots get nervous about food. For many vendors that's a fine trade — convenience is worth something.",
      ]),
      us("None — free listings, 0% platform fees", [
        "Self-sown is the zero-fee pre-order store: customers order and pay ahead (Bitcoin, cards via your own Stripe/Square, or pay at pickup by Venmo/Zelle/cash), and the Saturday handoff is a list instead of a queue. The store link goes on a QR code at the booth; regulars reorder without you doing anything.",
        "Unlike Square, the store and customer list are yours — listings live on open Nostr relays — and there's local-food marketplace discovery on top. You can even keep Square as the card processor inside Self-sown; we don't touch the money either way.",
      ]),
      comp("shopify", "The catch", "$39/mo for a market side-hustle", [
        "If the booth is becoming a brand — packaged goods, shipping, wholesale inquiries — Shopify is the conventional upgrade path.",
        "For pre-orders and a market table, it's paying retail-brand rent on a market-garden income.",
      ]),
      comp("facebook-marketplace", "The catch", "It's a post, not a store", [
        "Announcing 'here's what we're bringing Saturday' to a local audience is free and effective. Taking the actual pre-orders there means Messenger chaos.",
      ]),
      comp("local-line", "The catch", "Priced for wholesale", [
        "If some of your market customers are actually chefs, Local Line's wholesale price lists are the right upgrade. At $79/mo billed annually, it's for vendors with a real B2B book.",
      ]),
    ],
    myPick: [
      "Square readers at the booth + simplest possible pre-orders: Square Online is honestly great.",
      "Want zero fees and a store you own, and fine pairing a reader with a separate store: Self-sown.",
    ],
    actionSteps: [
      "Set up pre-orders before next market day — even five orders is five guaranteed sales.",
      "Put the store's QR code on the table, the tent, and every bag.",
      "Tell your regulars once; they'll do the rest.",
    ],
    faq: [
      {
        q: "How do farmers market vendors take pre-orders online?",
        a: "A store with market-pickup: Square Online (free + processing, unified with their POS) or Self-sown (free, zero platform fees, any payment rail). Customers order during the week and pick up at the booth.",
      },
      {
        q: "Do I need my online store and card reader to be the same system?",
        a: "No — it's convenient (Square) but not necessary. Plenty of vendors run a Self-sown store for pre-orders and a Square reader at the booth; the two don't need to share inventory at market scale.",
      },
      {
        q: "What's the cheapest option?",
        a: "Self-sown and Square Online are both $0/mo. Square takes ~2.9% + 30c online; on Self-sown card processing is whatever your own Stripe/Square account charges, and Bitcoin payments have no processing fee.",
      },
    ],
    related: [
      { href: "/vs/square-online", label: "Self-sown vs Square Online" },
      { href: "/alternatives/square-online", label: "Square Online alternatives" },
      { href: "/best/platform-for-selling-eggs-produce", label: "Best platform for eggs & produce" },
    ],
  },

  "platform-for-selling-honey-preserves": {
    kind: "best",
    path: "/best/platform-for-selling-honey-preserves",
    h1: "The best platform for selling honey & preserves (2026)",
    metaTitle: "Best Platform for Selling Honey & Preserves Online (2026)",
    metaDescription:
      "Honey and jam ship well and keep forever — but platform fees sting on small jars. The best platforms for selling honey & preserves in 2026, honestly compared.",
    disclosure: DISCLOSURE,
    intro: [
      "Honey and preserves are nearly perfect e-commerce products: shelf-stable, shippable, giftable. The catch is the price point — an $8-12 jar can't absorb platform fees the way a $60 candle can, so the fee structure matters more here than almost anywhere.",
      "Here's the honest field.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Self-sown (ours)", "Keeping 100% of small-jar margins", "Free; 0% platform fees"],
        ["Etsy", "Reaching gift & pantry buyers", "~10% per sale"],
        ["Square Online", "Market vendors adding online", "Free + ~2.9% + 30c"],
        ["Shopify", "Building a pantry brand", "$39/mo + apps"],
        ["Facebook Marketplace", "Local porch-pickup sales", "Free local; 10% shipped"],
      ],
    },
    sections: [
      {
        heading: "The small-jar math",
        paragraphs: [
          "On a $10 jar of honey, Etsy's stack (listing + 6.5% + ~3% + $0.25) takes about $1.20-1.40 — call it 13%. Ten jars a week is $600+/yr in fees for the privilege of a storefront. Zero-fee platforms aren't a nice-to-have at this price point; they're the difference between a business and a hobby that pays for itself.",
        ],
      },
      {
        heading: "Cottage food law is yours either way",
        paragraphs: [
          "Every platform below leaves legal compliance to you — but they differ in gatekeeping. Etsy restricts many food categories and Facebook's bots randomly flag preserves; Self-sown doesn't gatekeep at all. Your state's cottage-food rules apply wherever you sell, so know them first.",
        ],
      },
    ],
    picks: [
      us("None — $0 on a $10 jar", [
        "Self-sown's zero platform fees are worth the most at exactly this price point: the full $10 lands with you (minus only your own card processing, or nothing at all over Bitcoin Lightning/Cashu). Variants handle the half-pint/pint/quart ladder, and shipping labels are on the optional Herd plan ($21/mo).",
        "No food-category gatekeeping, no bots flagging your jam, and the store lives on open Nostr relays — your recipe lineup and customer list are yours.",
      ]),
      comp("etsy", "The catch", "~13% of a $10 jar", [
        "Etsy's gift-and-pantry search traffic is real: people search 'raw wildflower honey' and 'jalapeño jam' there every day, and a new shop can catch those buyers with zero marketing.",
        "At preserves price points the fees are proportionally worst — this is a channel for finding customers, not keeping them.",
      ]),
      comp("square-online", "The catch", "Generic store, no discovery", [
        "If you sell honey at the farmers market with a Square reader, the free online store on the same account is the zero-friction add-on.",
      ]),
      comp("shopify", "The catch", "Monthly rent on a pantry shelf", [
        "The platform for turning a jam lineup into a brand — subscriptions, gift sets, wholesale. Justify $39/mo only when the brand revenue already exists.",
      ]),
      comp("facebook-marketplace", "The catch", "Bots flag food listings", [
        "Free local reach for porch-pickup honey sales — when the listing survives moderation. Food sellers know the drill; keep screenshots of your listings.",
      ]),
    ],
    myPick: [
      "Sell on Self-sown free; if you want gift-buyer traffic, run an Etsy shop too and treat its fees as advertising.",
      "Put your own store's link on every jar label — the second purchase should never pay a platform fee.",
    ],
    actionSteps: [
      "List your full lineup on Self-sown with size variants (free).",
      "Put the store URL on every label before your next market.",
      "If you open Etsy, list only the three gift-iest items — let it hunt for customers, not host your whole business.",
    ],
    faq: [
      {
        q: "Can I legally sell homemade jam and honey online?",
        a: "Usually yes under your state's cottage-food law, which sets its own rules (allowed products, sales caps, labeling, whether shipping is allowed). The platform doesn't change the law — check your state's rules first.",
      },
      {
        q: "What's the cheapest way to sell honey online?",
        a: "Self-sown: free listings and no platform fees, so a $10 jar nets you $10 minus only payment processing (zero over Bitcoin). Etsy takes roughly 13% at that price point.",
      },
      {
        q: "Does Etsy allow selling honey and preserves?",
        a: "Some shelf-stable foods are allowed under Etsy's policies; many homemade food categories are restricted, and enforcement is inconsistent. Read their current policy before listing — and don't build a food business on a platform that can end it by policy update.",
      },
    ],
    related: [
      { href: "/vs/etsy", label: "Self-sown vs Etsy" },
      { href: "/alternatives/etsy", label: "Etsy alternatives" },
      { href: "/best/ecommerce-platform-for-homesteaders", label: "Best e-commerce for homesteaders" },
    ],
  },

  "ecommerce-for-raw-milk-dairies": {
    kind: "best",
    path: "/best/ecommerce-for-raw-milk-dairies",
    h1: "The best e-commerce platform for raw milk dairies (2026)",
    metaTitle: "Best E-commerce for Raw Milk Dairies: 5 Honest Picks (2026)",
    metaDescription:
      "Raw milk dairies get deplatformed by mainstream e-commerce. The best options in 2026 — starting with the ones that won't freeze your account. Honest comparison.",
    disclosure: DISCLOSURE,
    intro: [
      "Raw milk e-commerce has a problem no other food category has: the platform itself is the risk. Payment processors list raw dairy in restricted categories, marketplace bots flag the listings, and dairies lose stores and funds with no appeal — even in states where their sales are completely legal.",
      "So this ranking weights something other guides ignore: can the platform take your store down? Prices checked October 2026.",
    ],
    table: {
      columns: ["Option", "Deplatforming risk", "Cost"],
      rows: [
        ["Self-sown (ours)", "None — your store, your relays, your money", "Free; 0% platform fees"],
        ["GrazeCart", "Low-moderate — farm-friendly, but hosted + card rails", "$89/mo Starter"],
        ["Barn2Door", "Low-moderate — farm-specific, same hosted risk", "$119-299/mo + setup"],
        ["Square Online", "High — processor risk reviews hit raw dairy", "Free + processing"],
        ["Facebook Marketplace", "Extreme — bots flag raw milk on sight", "Free local"],
      ],
    },
    sections: [
      {
        heading: "Legal first, platform second",
        paragraphs: [
          "Raw milk law is a state-by-state patchwork — retail-legal in some states, herd-share-only in others, illegal to sell for human consumption in a few. Nothing any platform does changes that, and compliance is yours. What the platform changes is whether a legal dairy can keep a store online and get paid.",
        ],
      },
      {
        heading: "Why payment custody is the real issue",
        paragraphs: [
          "The painful stories aren't about deleted listings — they're about held funds. When your card processor decides raw dairy is too hot, they hold the money for 90-180 days. Architectures where the platform or processor sits between you and the customer's money carry that risk no matter how farm-friendly their marketing is.",
        ],
      },
    ],
    picks: [
      us("None — no account to freeze, no funds to hold", [
        "Self-sown is structurally different: your store lives on open Nostr relays under your keys (no account to suspend), and payments settle directly to you — Bitcoin over Lightning/Cashu with no processor at all, or cards through your own Stripe/Square account if you choose.",
        "There's no category review because there's no gatekeeper: you follow your state's law, and your store stays up. For a legal raw dairy that's been burned — or just read the horror stories — this is the only option on the list where deplatforming isn't a risk to price in.",
      ]),
      comp("grazecart", "The catch", "Still a hosted store on card rails", [
        "The farm-built store with sell-by-weight (handy for cream and bottling variants) and real ranch/dairy pedigree. The team understands this world.",
        "But it's a hosted platform taking card payments: the custody risk is theirs to manage, not eliminated. $89/mo Starter.",
      ]),
      comp("barn2door", "The catch", "Same hosted-model risk, higher price", [
        "Full-service farm e-commerce with subscriptions (natural fit for weekly milk pickups) and delivery routing.",
        "$1,827+ year one, and the same structural exposure: hosted store, processed payments, terms of service.",
      ]),
      comp("square-online", "The catch", "Processor risk reviews", [
        "Free and convenient — and the single most common villain in raw-dairy fund-hold stories. Square's risk systems flag restricted-adjacent food categories, and dairy money gets held.",
        "Fine as a backup card rail you can afford to lose; dangerous as your only one.",
      ]),
      comp("facebook-marketplace", "The catch", "Listings don't survive the bots", [
        "Raw milk listings are auto-flagged constantly, groups get restricted, and there's no appeal. Some dairies run coded language and herd-share 'not for sale' posts; all of it is one algorithm update from gone.",
        "Use it for discovery at most, never for the store.",
      ]),
    ],
    myPick: [
      "Self-sown — this is the category we exist for. Free, uncensorable, and your money never touches us.",
      "If you need catch-weight and subscriptions on a conventional stack: GrazeCart, and keep a Bitcoin rail ready as backup.",
    ],
    actionSteps: [
      "Open a free Self-sown store and put the link everywhere your customers already gather.",
      "Set up Bitcoin (Lightning) acceptance so no single processor is a single point of failure.",
      "If you keep a card processor, never let its balance grow — sweep early and often.",
    ],
    faq: [
      {
        q: "Why do raw milk dairies get deplatformed?",
        a: "Payment processors classify raw dairy as restricted or high-risk, and marketplace moderation bots flag the category. Even fully legal, state-permitted dairies get accounts frozen — the enforcement is automated and appeals are slow.",
      },
      {
        q: "Is it legal to sell raw milk online?",
        a: "It depends entirely on your state: retail sales, farm-gate only, herd shares, or prohibited. The platform doesn't change the law — know your state's rules and follow them.",
      },
      {
        q: "Can I sell herd shares on Self-sown?",
        a: "You can list anything; the legal structure of herd-share agreements is between you, your members, and your state's law. Self-sown doesn't gatekeep categories.",
      },
      {
        q: "How do I take payment without a processor that can freeze me?",
        a: "Bitcoin over Lightning or Cashu settles directly to your wallet with no processor in the middle. Self-sown supports both, plus manual fiat (Venmo/Zelle/cash) and cards via your own account.",
      },
    ],
    related: [
      { href: "/vs/barn2door", label: "Self-sown vs Barn2Door" },
      { href: "/vs/facebook-marketplace", label: "Self-sown vs Facebook Marketplace" },
      { href: "/best/online-marketplace-for-farmers", label: "Best online marketplace for farmers" },
    ],
  },

  "marketplace-for-handmade-soap-candles": {
    kind: "best",
    path: "/best/marketplace-for-handmade-soap-candles",
    h1: "The best marketplace for handmade soap & candles (2026)",
    metaTitle: "Best Marketplace for Handmade Soap & Candles: 5 Picks (2026)",
    metaDescription:
      "Etsy owns handmade search traffic — and takes 10%+ for it. The best marketplaces for soap & candle makers in 2026, honestly ranked.",
    disclosure: DISCLOSURE,
    intro: [
      "Soap and candles are Etsy's heartland, and honesty requires starting there: no other platform delivers that many buyers searching for exactly what you make. The honest follow-up: Etsy knows it, and prices accordingly — the stacked fees pass 10% of every order.",
      "Here are the five places worth selling, with Etsy ranked where it belongs and the fee-free alternative right behind.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Etsy", "Built-in buyer traffic from day one", "~10%+ stacked per-sale fees"],
        ["Self-sown (ours)", "Keeping 100% on repeat & local sales", "Free; 0% platform fees"],
        ["Shopify", "Building a standalone candle/soap brand", "$39/mo + apps"],
        ["Square Online", "Craft-fair POS + online store", "Free + ~2.9% + 30c"],
        ["Facebook Marketplace", "Local pickup sales", "Free local; 10% shipped"],
      ],
    },
    sections: [
      {
        heading: "Discovery vs ownership",
        paragraphs: [
          "Every soap maker's dilemma: Etsy finds you customers and owns them; your own store owns them but can't find them. The winners in this category run both — marketplace for discovery, owned store for the relationship — and the economics only work if the owned store is free.",
        ],
      },
    ],
    picks: [
      comp("etsy", "The price", "~10-15% of every order, forever", [
        "The honest #1 for a new maker: millions of buyers search Etsy for handmade soap and candles daily, and a brand-new shop can sell within days. No other platform hands you that.",
        "The cost compounds: listing + 6.5% transaction + processing on every order, 12-15% more when Offsite Ads claims the sale (mandatory over $10k/yr), and zero ownership of the customer relationship. Etsy is a customer-acquisition channel priced like a business partner.",
      ]),
      us("None — you keep the whole sale", [
        "Self-sown is where the customers Etsy finds should end up: a free store with unlimited listings, zero platform fees, and a link that goes on every label and package insert. The second purchase — and soap buyers always make a second purchase — pays no platform anything.",
        "Payments settle straight to you (Bitcoin, your own Stripe/Square, or cash apps), and the store lives on open Nostr relays, so a policy update can't suspend your shop the week before the holiday rush.",
      ]),
      comp("shopify", "The catch", "Rent before revenue", [
        "The platform for the brand-building phase: subscriptions (soap-of-the-month works), email funnels, total design control.",
        "Justify $39/mo plus apps only when monthly revenue makes it a rounding error.",
      ]),
      comp("square-online", "The catch", "No discovery", [
        "If you sell at craft fairs with a Square reader, the free online store on the same account handles reorders fine — as long as you bring the customers.",
      ]),
      comp("facebook-marketplace", "The catch", "No repeat-purchase flow", [
        "Free local reach for gift-season pushes and seconds sales. It's a billboard, not a store.",
      ]),
    ],
    myPick: [
      "New maker: Etsy for discovery + Self-sown (free) as the store your packaging points to.",
      "Established maker with repeat buyers: shift them to Self-sown and watch the 10% become margin.",
    ],
    actionSteps: [
      "Open a free Self-sown store today; list your five best sellers.",
      "Add the store link to every label, package insert, and market-booth sign.",
      "Keep Etsy for discovery; measure what percentage of orders are repeats, and what those repeats cost you there.",
    ],
    faq: [
      {
        q: "Is Etsy worth it for soap and candles in 2026?",
        a: "For discovery, yes — its handmade search traffic is unmatched. As the only home for an established shop, the ~10-15% total take is hard to justify when a free owned store exists.",
      },
      {
        q: "What's the cheapest place to sell handmade soap online?",
        a: "Self-sown: free listings, zero platform fees. Square Online is $0/mo + ~2.9% processing. Etsy costs roughly 10%+ per order all-in.",
      },
      {
        q: "How do I get repeat buyers off Etsy without violating its rules?",
        a: "You can't solicit in Etsy messages — but your packaging, labels, and inserts are yours. A store link on the physical product is the standard, legitimate play.",
      },
    ],
    related: [
      { href: "/vs/etsy", label: "Self-sown vs Etsy" },
      { href: "/alternatives/etsy", label: "Etsy alternatives" },
      { href: "/best/marketplace-for-wool-fiber", label: "Best marketplace for wool & fiber" },
    ],
  },

  "platform-for-selling-eggs-produce": {
    kind: "best",
    path: "/best/platform-for-selling-eggs-produce",
    h1: "The best platform for selling eggs & produce (2026)",
    metaTitle: "Best Platform for Selling Eggs & Produce Online (2026)",
    metaDescription:
      "Eggs and produce are low-price, hyperlocal, and perishable — most platforms fit badly. The best options in 2026, honestly compared with real fees.",
    disclosure: DISCLOSURE,
    intro: [
      "Eggs and produce break the assumptions of most e-commerce platforms. The orders are small ($5-20), the customers are all local, the inventory changes weekly, and shipping usually isn't a thing. A platform charging 10% per order or $100/mo isn't a tool for this — it's a tax on it.",
      "Here's what actually works, honestly ranked.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Self-sown (ours)", "Zero-fee pre-orders from local regulars", "Free; 0% platform fees"],
        ["Facebook Marketplace", "Free surplus announcements", "Free local"],
        ["Square Online", "Market vendors adding pre-orders", "Free + ~2.9% + 30c"],
        ["Local Line", "Farms adding CSA/wholesale", "From $79/mo"],
        ["Barn2Door", "Established farms with delivery routes", "$119-299/mo + setup"],
      ],
    },
    sections: [
      {
        heading: "The egg math",
        paragraphs: [
          "A $5 dozen of eggs is the acid test. On Etsy-style fee stacks it's not worth listing. On $100/mo platforms you'd need to sell hundreds of dozens just to cover the store. The only sane economics for small-item local food are: free platform, direct payment, and a customer close enough to pick up.",
        ],
      },
      {
        heading: "Pre-orders beat inventory",
        paragraphs: [
          "The unlock for eggs and produce isn't listing what you have — it's taking orders for what you'll have. Regulars order during the week, you harvest to order, pickup is a handshake. Every option below is ranked partly on how well it does that loop.",
        ],
      },
    ],
    picks: [
      us("None — $5 stays $5", [
        "Self-sown is built for exactly this shape: unlimited free listings (this week's availability updates in minutes), a standing pre-order link for your regulars, and payments that settle straight to you — Bitcoin, cards via your own Stripe/Square, or the Venmo/Zelle/cash your customers already use.",
        "Zero platform fees means the $5 dozen stays a $5 dozen, and the store on open Nostr relays means nobody's bot ever flags your duck eggs. Add a custom domain and email flows on Herd ($21/mo) if the stand grows.",
      ]),
      comp("facebook-marketplace", "The catch", "Every sale starts from zero", [
        "The best free surplus valve in existence: 'extra eggs this week, $5/dozen' reaches your whole county in an hour.",
        "There's no store behind it — no reorders, no regulars list, no record. Use it to find customers, then hand them a real store link.",
      ]),
      comp("square-online", "The catch", "Generic, no local discovery", [
        "Free pre-order store bolted to your market card reader. Handles the weekly order-pickup loop fine; knows nothing about food or farms.",
      ]),
      comp("local-line", "The catch", "~$950/yr is a lot of eggs", [
        "The right upgrade when 'egg route' becomes 'CSA program with add-ons' or when restaurants start calling. Until then the subscription costs more than the problem.",
      ]),
      comp("barn2door", "The catch", "Built for bigger operations", [
        "Delivery routing and subscriptions at farm-platform prices. A great platform for the farm you'll be in five years, maybe.",
      ]),
    ],
    myPick: [
      "Self-sown free store for your regulars + Facebook posts pointing at it. Total cost: $0.",
      "Graduate to paid platforms only when CSA subscriptions or wholesale make the fee obviously worth it.",
    ],
    actionSteps: [
      "Open a free Self-sown store; list your standing items (eggs, weekly veg box, whatever's on).",
      "Share the link with your ten best customers and put a QR code at the stand.",
      "Post surplus on Facebook with the store link — harvest the reach, keep the customer.",
    ],
    faq: [
      {
        q: "What's the best way to sell eggs online?",
        a: "A free pre-order store your regulars bookmark: Self-sown (free, zero fees) or Square Online (free + processing). Facebook Marketplace finds new local customers free but can't handle the repeat relationship.",
      },
      {
        q: "Can I sell homegrown produce online legally?",
        a: "Generally yes for raw whole produce — it's among the least-regulated food sales. Eggs have state-specific rules (grading, labeling, refrigeration). Check your state agriculture department's page; platform choice doesn't change the law.",
      },
      {
        q: "Is it worth paying for a farm platform for eggs and produce?",
        a: "Not at the start. $79-299/mo platforms (Local Line, Barn2Door) earn their fee with subscriptions, routing, and wholesale — features that matter at a scale most egg-and-veg sellers haven't reached yet.",
      },
    ],
    related: [
      { href: "/vs/facebook-marketplace", label: "Self-sown vs Facebook Marketplace" },
      { href: "/best/ecommerce-platform-for-homesteaders", label: "Best e-commerce for homesteaders" },
      { href: "/best/online-marketplace-for-farmers", label: "Best online marketplace for farmers" },
    ],
  },

  "marketplace-for-wool-fiber": {
    kind: "best",
    path: "/best/marketplace-for-wool-fiber",
    h1: "The best marketplace for wool & fiber producers (2026)",
    metaTitle: "Best Marketplace for Wool & Fiber Producers: 5 Picks (2026)",
    metaDescription:
      "From raw fleece to handspun yarn — the fiber community buys online more than any other farm niche. The best marketplaces in 2026, honestly ranked.",
    disclosure: DISCLOSURE,
    intro: [
      "Fiber is the unusual farm product where buyers are genuinely everywhere — the handspinning, knitting, and weaving community is national, online-native, and happy to pay shipping for the right fleece or yarn. That changes the platform math: discovery matters more here than for eggs or produce.",
      "Here's the honest ranking for fiber producers.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Etsy", "The fiber community's search engine", "~10%+ stacked fees"],
        ["Self-sown (ours)", "Zero-fee sales to your own following", "Free; 0% platform fees"],
        ["Shopify", "Fiber brands with national reach", "$39/mo + apps"],
        ["Facebook Marketplace", "Raw fleece & local sales", "Free local; 10% shipped"],
        ["Square Online", "Fiber-festival POS + online", "Free + ~2.9% + 30c"],
      ],
    },
    sections: [
      {
        heading: "Why fiber is Etsy's strongest category",
        paragraphs: [
          "Spinners search 'romney roving' and 'undyed cormo fleece' on Etsy the way cooks search recipes on Google. A new fiber shop with good photos and honest micron counts can sell nationally from day one. For this category specifically, Etsy's ~10% buys something real.",
        ],
      },
      {
        heading: "The two-product split",
        paragraphs: [
          "Fiber operations sell two different things: commodity raw fleece (heavy, price-sensitive, often local) and value-added goods — roving, yarn, batts, finished textiles (shippable, margin-rich, national). The smart setup prices each on the platform that fits: Etsy for the yarn buyers who search, an owned free store for the flock-followers who already know your animals by name.",
        ],
      },
    ],
    picks: [
      comp("etsy", "The price", "~10-15% of each order", [
        "For fiber specifically, Etsy earns its ranking: the community's buying habits run through its search box, and 'handspun' buyers there pay real prices. Start here if you have no audience.",
        "The known costs: stacked fees on every order, mandatory Offsite Ads over $10k/yr, and customers who remember 'Etsy' instead of your farm's name.",
      ]),
      us("None — keep 100% of every skein", [
        "Self-sown is the free store for the audience you already have — the farm's Instagram followers, fiber-festival regulars, the shepherd's pie of repeat buyers. Zero platform fees on a $28 skein of handspun is $3+ back per sale versus Etsy.",
        "Listings live on open Nostr relays (your store, your rules), payments settle straight to you, and variants handle colorway/weight ladders cleanly. The honest gap: no built-in search traffic — bring your own following.",
      ]),
      comp("shopify", "The catch", "Monthly rent, national scope", [
        "The platform for fiber brands graduating to wholesale (yarn shops) and subscription clubs. If 'fiber CSA' is your model, the subscription apps justify the fee.",
      ]),
      comp("facebook-marketplace", "The catch", "Local only, feed-only", [
        "Raw fleece moves locally on Facebook — spinners' guild groups and Marketplace are where a whole fleece finds a home without shipping math. No store features at all.",
      ]),
      comp("square-online", "The catch", "A checkout, not a channel", [
        "Fiber-festival POS plus a free online store on the same inventory. Functional, generic, discovery-free.",
      ]),
    ],
    myPick: [
      "Yarn and roving with no audience yet: Etsy, and pay the fees gladly as marketing.",
      "Any existing following: Self-sown free store as home base, Etsy as the billboard.",
    ],
    actionSteps: [
      "List your current inventory on a free Self-sown store — photos, micron counts, the animals' names.",
      "Open Etsy with your most search-friendly items (undyed roving, breed-specific fleece).",
      "Put the store link in every shipped order; a fiber buyer is a buyer for years.",
    ],
    faq: [
      {
        q: "Where do spinners and knitters buy fiber online?",
        a: "Etsy's search dominates for yarn, roving, and breed-specific fleece. Ravelry-adjacent communities and Instagram drive the rest — which is why an owned store (Self-sown) matters: social followers need somewhere to buy.",
      },
      {
        q: "What's the cheapest way to sell yarn online?",
        a: "Self-sown — free listings, zero platform fees. On a $28 skein, Etsy's stack costs roughly $3+ per sale.",
      },
      {
        q: "Can I sell raw fleece online?",
        a: "Yes, and it sells — especially to handspinners hunting specific breeds. It ships heavy, so price shipping honestly; many producers sell fleece locally (Facebook) and value-added goods nationally.",
      },
    ],
    related: [
      { href: "/vs/etsy", label: "Self-sown vs Etsy" },
      { href: "/best/marketplace-for-handmade-soap-candles", label: "Best marketplace for soap & candles" },
      { href: "/alternatives/etsy", label: "Etsy alternatives" },
    ],
  },

  "online-store-for-flower-farms": {
    kind: "best",
    path: "/best/online-store-for-flower-farms",
    h1: "The best online store for flower farms (2026)",
    metaTitle: "Best Online Store for Flower Farms: 5 Honest Picks (2026)",
    metaDescription:
      "Bouquet subscriptions, wedding inquiries, market pre-orders — the best online stores for flower farms in 2026, honestly compared with real prices.",
    disclosure: DISCLOSURE,
    intro: [
      "Flower farming has three distinct revenue streams — bouquet subscriptions, wedding/event work, and market bunches — and they want different tooling. Subscriptions want recurring billing; weddings want inquiry forms; market pre-orders want a simple store. No platform does all three perfectly.",
      "Here's the honest field for 2026.",
    ],
    table: {
      columns: ["Option", "Best for", "Cost"],
      rows: [
        ["Square Online", "Market bunches + pre-orders on a POS", "Free + ~2.9% + 30c"],
        ["Self-sown (ours)", "Zero-fee storefront for all three streams", "Free; 0% platform fees"],
        ["Local Line", "Bouquet CSA subscriptions", "From $79/mo"],
        ["Shopify", "Flower brands with shipping", "$39/mo + apps"],
        ["Facebook Marketplace", "Selling this week's bunches", "Free local"],
      ],
    },
    sections: [
      {
        heading: "Seasons and subscriptions",
        paragraphs: [
          "The flower farm's calendar is lumpy: CSA-style bouquet subscriptions in season, wedding inquiries year-round, holiday wreath pushes in December. The ideal platform costs nothing in February and handles a subscription rush in June — which is why the monthly-fee platforms hurt here more than in year-round categories.",
        ],
      },
    ],
    picks: [
      comp("square-online", "The catch", "Generic, no subscription depth", [
        "The honest pick for pure convenience: free online ordering on the same Square account you use at the farmers market, with pre-orders for market pickup working out of the box. For the market-bunch stream, it's hard to beat.",
        "It knows nothing about flowers: no bouquet-subscription machinery, no wedding workflow, no floral anything. It's a cash register with a URL.",
      ]),
      us("None — free all winter", [
        "Self-sown fits the flower calendar because it's free: the store costs nothing in the off-season and unlimited listings handle every stream — weekly bouquet listings with pickup details, a wedding-inquiry page, wreath pre-orders in December.",
        "Payments settle straight to you (Bitcoin, cards via your own Stripe/Square, or cash apps), email flows for 'subscriptions open Saturday' announcements come with Herd ($21/mo, cancel anytime), and the store on open Nostr relays is yours in a way a rented platform never is.",
      ]),
      comp("local-line", "The catch", "~$950/yr, annual billing", [
        "If the bouquet CSA is the business — 50+ weekly subscribers with pickup sites — Local Line's subscription machinery is the deepest here and worth the fee.",
        "For a farm selling bunches and wedding work, it's expensive depth you won't use.",
      ]),
      comp("shopify", "The catch", "Overkill for seasonal", [
        "The brand play: dried-flower shipping, candle-adjacent gift lines, subscription apps. Justify it when the off-farm revenue is real.",
      ]),
      comp("facebook-marketplace", "The catch", "No permanence", [
        "Announcing this week's bunches to a local audience is free and effective. Weddings and subscriptions can't run on a feed.",
      ]),
    ],
    myPick: [
      "Market bunches + pre-orders: Square Online for POS unity, or Self-sown for zero fees and ownership.",
      "Bouquet CSA at scale: Local Line. Everything else: Self-sown free.",
    ],
    actionSteps: [
      "Open a free Self-sown store: list this week's bunches, your wedding inquiry page, and next season's CSA waitlist.",
      "Put the store link on the market tent and in your Instagram bio.",
      "If the CSA outgrows a signup list next season, price Local Line then — not before.",
    ],
    faq: [
      {
        q: "How do flower farms sell bouquet subscriptions online?",
        a: "Local Line has the deepest CSA-subscription tooling (~$79/mo). For smaller programs, a free Self-sown store with a signup list and email flows (Herd, $21/mo) covers it.",
      },
      {
        q: "What's the cheapest online store for a flower farm?",
        a: "Self-sown (free, zero platform fees) or Square Online (free + ~2.9% processing). Both cost nothing in the off-season, which matters for a seasonal business.",
      },
      {
        q: "Can I take wedding deposits online?",
        a: "Yes — a deposit listing on Self-sown or Square Online handles it. The consultation and contract stay personal; only the money moves online.",
      },
    ],
    related: [
      { href: "/vs/square-online", label: "Self-sown vs Square Online" },
      { href: "/vs/local-line", label: "Self-sown vs Local Line" },
      { href: "/best/online-store-for-farmers-market-vendors", label: "Best online store for market vendors" },
    ],
  },
};
