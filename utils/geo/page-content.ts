// Machine-readable representations of the main content pages, used for
// content negotiation: when an LLM/agent requests one of these paths with
// `Accept: text/markdown`, `Accept: application/json`, or `Accept: text/plain`
// (or identifies as a known LLM crawler), it receives this structured content
// instead of the full HTML app shell. Browsers and SEO/social crawlers keep
// getting the normal HTML so OpenGraph and SSR behaviour are untouched.

export interface PageContent {
  title: string;
  description: string;
  markdown: string;
}

const SITE = "https://milk.market";

export const PAGE_CONTENT: Record<string, PageContent> = {
  "/": {
    title: "Milk Market — Permissionless marketplace for local food",
    description:
      "A Bitcoin-native, Nostr-based marketplace for local food and decentralized food systems. Buy and sell raw milk, dairy, meat, eggs, produce, and more.",
    markdown: `# Milk Market

Milk Market is a permissionless, Bitcoin-native marketplace for **local food and decentralized food systems**, built on the Nostr protocol. Producers sell directly to buyers with no central gatekeeper.

## What you can buy and sell
Raw milk and dairy, meat, eggs, fresh produce, baked goods, honey, and other local and handmade goods.

## Payments
Bitcoin over the Lightning Network, Cashu ecash, Stripe (cards), and manual fiat (Venmo, Cash App, Zelle, and more).

## Get started
- Browse the [marketplace](${SITE}/marketplace)
- Become a seller with the [Producer Guide](${SITE}/producer-guide)
- Learn more [about Milk Market](${SITE}/about) or read the [FAQ](${SITE}/faq)

## For AI agents
Use the Model Context Protocol server at \`${SITE}/api/mcp\`. See [/llms.txt](${SITE}/llms.txt), [/agents.txt](${SITE}/agents.txt), and [/skill.md](${SITE}/skill.md).`,
  },
  "/about": {
    title: "About Milk Market",
    description:
      "Milk Market's mission: connecting local food producers directly with buyers through a permissionless, censorship-resistant marketplace on Nostr.",
    markdown: `# About Milk Market

Milk Market connects local food producers directly with buyers through a permissionless, censorship-resistant marketplace built on the **Nostr protocol**.

Anyone can become a producer without asking permission. Listings live on Nostr relays, so no single company can remove a producer from the network. Raw milk and dairy were the founding use case, but the marketplace serves local food broadly: meat, eggs, produce, baked goods, honey, and handmade goods.

## Why it exists
To rebuild local and decentralized food supply chains — giving producers a direct, sovereign channel to their customers and giving buyers transparent access to local food, paid for with open money (Bitcoin) or familiar methods (cards, fiat).

Links: [Marketplace](${SITE}/marketplace) · [Producer Guide](${SITE}/producer-guide) · [FAQ](${SITE}/faq) · [Contact](${SITE}/contact)`,
  },
  "/faq": {
    title: "Milk Market FAQ",
    description:
      "Answers to common questions about Milk Market — payments, selling, privacy, Nostr, and AI-agent access.",
    markdown: `# Milk Market FAQ

**What can I sell?** Local food and goods of all kinds — raw milk and dairy are one example, alongside meat, eggs, produce, baked goods, honey, and handmade goods.

**How do payments work?** Bitcoin (Lightning, Cashu ecash), Stripe cards, and manual fiat. Buyers can check out as a guest with just an email, or with their own Nostr keys.

**Is it really permissionless?** Yes. Listings are Nostr events on open relays; there is no central approval step.

**How is my data handled?** Orders and messages are end-to-end encrypted (NIP-17). The platform caches public listings in PostgreSQL for search and fast page loads.

**Can AI agents use Milk Market?** Yes — via the Model Context Protocol server at \`${SITE}/api/mcp\`. See [/llms.txt](${SITE}/llms.txt) and [/skill.md](${SITE}/skill.md).`,
  },
  "/contact": {
    title: "Contact Milk Market",
    description: "Reach the Milk Market team via Nostr, GitHub, X, or email.",
    markdown: `# Contact Milk Market

- Email: freemilk@milk.market
- Nostr: ${SITE === "https://milk.market" ? "https://njump.me/milkmarket" : ""}
- X: https://x.com/milkmarketmedia
- Source code: https://github.com/shopstr-eng/milk-market

Want to browse local food? Visit the [marketplace](${SITE}/marketplace).`,
  },
  "/producer-guide": {
    title: "Milk Market Producer Guide",
    description:
      "Step-by-step guide to selling local food on Milk Market: account, membership, listings, orders, storefront, email flows, and AI agents.",
    markdown: `# Producer Guide

How to start selling local food and goods on Milk Market.

1. **Create your account** with a Nostr identity (new or existing).
2. **Choose your membership** — a free plan with unlimited listings, Herd ($21/month or $168/year, saving 33%) with a 30-day free trial for new sellers, or Wrangler (one-time $1,050) for lifetime access to every Herd feature.
3. **List your first product** — title, description, price, images, categories, shipping, pickup, variants, and bulk pricing.
4. **Manage orders & communication** through encrypted buyer chat.
5. **Customize your storefront** (Herd) — colors, fonts, page builder, SEO/OG meta, and a custom domain.
6. **Automate your email flows** (Herd) — welcome series, order follow-ups, re-engagement.
7. **Buy shipping labels** (Herd) — connect your own Shippo account, quote live rates, buy labels, and issue returns from the orders dashboard.
8. **Connect AI agents with MCP** (Herd) so autonomous agents can manage listings and orders.
9. **Grow your business** — update listings, build relationships, share your story, and expand reach.

Start at the [marketplace](${SITE}/marketplace) or read the [FAQ](${SITE}/faq).`,
  },
  "/terms": {
    title: "Milk Market Terms of Service",
    description: "Terms governing use of the Milk Market marketplace.",
    markdown: `# Terms of Service

This is a machine-readable summary. The authoritative terms are rendered at [${SITE}/terms](${SITE}/terms).

Milk Market is a permissionless marketplace; producers and buyers transact directly. The platform provides discovery, caching, payments tooling, and storefronts but is not a party to individual transactions. Use of the AI-agent (MCP) interface is subject to the policies in [/agents.txt](${SITE}/agents.txt).`,
  },
  "/privacy": {
    title: "Milk Market Privacy Policy",
    description: "How Milk Market handles data and privacy.",
    markdown: `# Privacy Policy

This is a machine-readable summary. The authoritative policy is rendered at [${SITE}/privacy](${SITE}/privacy).

Orders and direct messages are end-to-end encrypted using Nostr (NIP-17 gift wraps). Public listings and profiles are cached in PostgreSQL for search and server-side rendering. Guest checkout requires only an email for order confirmation.`,
  },
};

export function getPageContent(path: string): PageContent | null {
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return PAGE_CONTENT[normalized] ?? null;
}
