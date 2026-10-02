// Lightweight path -> title/description map for the SEO comparison/guide
// pages. Deliberately separate from the content modules: dynamic-meta-head
// ships in the client bundle of EVERY page, so it must not import the full
// page bodies. Titles/descriptions mirror the content modules (same
// convention as STATIC_PAGE_META vs PAGE_CONTENT).

export const SEO_PAGE_META: Record<string, { title: string; description: string }> = {
  // Hubs
  "/vs": {
    title: "Honest Comparisons: Self-sown vs Shopify, Etsy, Barn2Door & More",
    description:
      "Head-to-head comparisons of Self-sown against Shopify, Etsy, Barn2Door, Square Online, Local Line, GrazeCart, Facebook Marketplace, and BeefMaps — with real 2026 pricing and honest verdicts.",
  },
  "/alternatives": {
    title: "Alternatives to Shopify, Etsy, Barn2Door & More (2026)",
    description:
      "The best alternatives to the big e-commerce platforms for farm, food, and artisan sellers — real prices, honest tradeoffs, zero platform fees.",
  },
  "/best": {
    title: "Best Platforms for Selling Local Food & Artisan Goods (2026)",
    description:
      "Honest 'best of' guides for farmers, ranchers, homesteaders, and makers — the best online marketplace for each audience, with real prices and genuine runner-ups.",
  },
  // vs pages
  "/vs/shopify": {
    title: "Self-sown vs Shopify: Honest Comparison for Farm & Food Sellers",
    description:
      "Shopify starts at $39/mo plus apps. Self-sown is free with zero platform fees. An honest comparison for farmers and food producers — including where Shopify wins.",
  },
  "/vs/etsy": {
    title: "Self-sown vs Etsy: Fees, Ownership & Honest Verdict (2026)",
    description:
      "Etsy takes $0.20 + 6.5% + processing on every sale, plus 12-15% on Offsite Ads. Self-sown charges nothing. An honest comparison for makers and food producers.",
  },
  "/vs/barn2door": {
    title: "Self-sown vs Barn2Door: Real Cost & Honest Comparison (2026)",
    description:
      "Barn2Door costs $119-299/mo plus a $399-599 setup fee. Self-sown is free with zero platform fees. An honest comparison for farms — including where Barn2Door wins.",
  },
  "/vs/square-online": {
    title: "Self-sown vs Square Online for Farm & Food Sellers (2026)",
    description:
      "Square Online's free plan takes ~2.9% + 30c online; Self-sown is free with zero platform fees and direct payments. Honest comparison, including where Square wins.",
  },
  "/vs/local-line": {
    title: "Self-sown vs Local Line: Honest Comparison for Farms (2026)",
    description:
      "Local Line starts at $79/mo billed annually plus processing. Self-sown is free with zero platform fees. Honest comparison — including where Local Line wins for food hubs.",
  },
  "/vs/grazecart": {
    title: "Self-sown vs GrazeCart for Ranches: Honest Comparison (2026)",
    description:
      "GrazeCart starts at $89/mo for sell-by-weight meat e-commerce. Self-sown is free with zero platform fees. Honest comparison for ranches — including where GrazeCart wins.",
  },
  "/vs/facebook-marketplace": {
    title: "Self-sown vs Facebook Marketplace for Local Food (2026)",
    description:
      "Facebook Marketplace is free for local pickup but has no store, no brand, and moderation bots that flag jam. Honest comparison with Self-sown.",
  },
  "/vs/beefmaps": {
    title: "Self-sown vs BeefMaps: Directory vs Store for Beef Ranches (2026)",
    description:
      "BeefMaps is a rancher-direct beef discovery directory; Self-sown is the free store where the sale actually happens. Honest comparison — and why you probably want both.",
  },
  // alternatives pages
  "/alternatives/shopify": {
    title: "5 Best Shopify Alternatives for Farm & Food Sellers (2026)",
    description:
      "Shopify's $39/mo plus apps is overkill for selling local food. The best Shopify alternatives for farmers, ranchers, and makers — honestly compared.",
  },
  "/alternatives/etsy": {
    title: "5 Best Etsy Alternatives: Keep Your Customer List (2026)",
    description:
      "Etsy's stacked fees pass 10% and the customer belongs to Etsy. The best Etsy alternatives for soap, candle, fiber, and food sellers — honestly compared.",
  },
  "/alternatives/barn2door": {
    title: "5 Best Barn2Door Alternatives: Honest Cost Comparison (2026)",
    description:
      "Barn2Door costs $1,800+ in year one. The best Barn2Door alternatives for farms — from free (Self-sown) to full-service — honestly compared.",
  },
  "/alternatives/square-online": {
    title: "5 Best Square Online Alternatives for Local Sellers (2026)",
    description:
      "Square Online is a fine free checkout but a generic store. The best Square Online alternatives for farm, food, and artisan sellers — honestly compared.",
  },
  "/alternatives/local-line": {
    title: "5 Best Local Line Alternatives for Farms (2026)",
    description:
      "Local Line starts at ~$950/yr billed annually. The best Local Line alternatives for farms and food hubs — from free to full-service — honestly compared.",
  },
  "/alternatives/grazecart": {
    title: "5 Best GrazeCart Alternatives for Meat & Ranch Sales (2026)",
    description:
      "GrazeCart's $89/mo Starter is great for catch-weight meat but steep for simple ranch stores. The best GrazeCart alternatives — honestly compared.",
  },
  "/alternatives/facebook-marketplace": {
    title: "5 Best Facebook Marketplace Alternatives for Local Food (2026)",
    description:
      "Facebook Marketplace is free but it's a feed, not a store. The best alternatives for farm & food sellers who want real storefronts — honestly compared.",
  },
  "/alternatives/beefmaps": {
    title: "5 Best BeefMaps Alternatives: Beef Directories & Stores (2026)",
    description:
      "BeefMaps is great for beef discovery but it's a directory, not a store. The best BeefMaps alternatives — including the store your listing should point to.",
  },
  // guides
  "/best/online-marketplace-for-farmers": {
    title: "Best Online Marketplace for Farmers: 5 Honest Picks (2026)",
    description:
      "The best online marketplaces and stores for farmers in 2026 — from free (Self-sown) to full-service (Barn2Door). Real prices, honest tradeoffs.",
  },
  "/best/ecommerce-platform-for-homesteaders": {
    title: "Best E-commerce Platform for Homesteaders: 5 Picks (2026)",
    description:
      "Homesteads sell a bit of everything — eggs, soap, seedlings, preserves. The best e-commerce platforms for homesteaders in 2026, honestly compared with real prices.",
  },
  "/best/platform-for-beef-ranches": {
    title: "Best Platform for Beef Ranches Selling Direct: 5 Picks (2026)",
    description:
      "The best platforms for ranches selling beef direct in 2026 — GrazeCart, Self-sown, BeefMaps, Barn2Door, Square. Real prices, honest tradeoffs.",
  },
  "/best/online-store-for-farmers-market-vendors": {
    title: "Best Online Store for Farmers Market Vendors: 5 Picks (2026)",
    description:
      "Pre-orders, market pickup, and the booth-to-online loop. The best online stores for farmers market vendors in 2026 — real prices, honest tradeoffs.",
  },
  "/best/platform-for-selling-honey-preserves": {
    title: "Best Platform for Selling Honey & Preserves Online (2026)",
    description:
      "Honey and jam ship well and keep forever — but platform fees sting on small jars. The best platforms for selling honey & preserves in 2026, honestly compared.",
  },
  "/best/ecommerce-for-raw-milk-dairies": {
    title: "Best E-commerce for Raw Milk Dairies: 5 Honest Picks (2026)",
    description:
      "Raw milk dairies get deplatformed by mainstream e-commerce. The best options in 2026 — starting with the ones that won't freeze your account. Honest comparison.",
  },
  "/best/marketplace-for-handmade-soap-candles": {
    title: "Best Marketplace for Handmade Soap & Candles: 5 Picks (2026)",
    description:
      "Etsy owns handmade search traffic — and takes 10%+ for it. The best marketplaces for soap & candle makers in 2026, honestly ranked.",
  },
  "/best/platform-for-selling-eggs-produce": {
    title: "Best Platform for Selling Eggs & Produce Online (2026)",
    description:
      "Eggs and produce are low-price, hyperlocal, and perishable — most platforms fit badly. The best options in 2026, honestly compared with real fees.",
  },
  "/best/marketplace-for-wool-fiber": {
    title: "Best Marketplace for Wool & Fiber Producers: 5 Picks (2026)",
    description:
      "From raw fleece to handspun yarn — the fiber community buys online more than any other farm niche. The best marketplaces in 2026, honestly ranked.",
  },
  "/best/online-store-for-flower-farms": {
    title: "Best Online Store for Flower Farms: 5 Honest Picks (2026)",
    description:
      "Bouquet subscriptions, wedding inquiries, market pre-orders — the best online stores for flower farms in 2026, honestly compared with real prices.",
  },
};
