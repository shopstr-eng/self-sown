# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-10-30

## Product Overview

**One-liner:** A global, permissionless marketplace for food freedom.
**What it does:** Self-sown connects local food producers and artisans directly with buyers. Sellers publish listings as Nostr events they own; the platform adds storefronts, a marketplace with search/discovery, payments (Bitcoin-native plus cards and manual fiat), email automation, and AI-agent interfaces on top.
**Product category:** E-commerce platform / online marketplace for farm and local food sellers — the "shelf" is next to Shopify, Etsy, Barn2Door, Square Online.
**Product type:** Marketplace + storefront builder hybrid on an open protocol (Nostr). Free hosted tier, paid membership, and a self-hostable option.
**Business model:** Freemium membership. Free plan: unlimited listings, no mandatory transaction fees, ever. Herd: $21/mo or $168/yr (33% saving), 30-day free trial. Wrangler: $2,100 one-time, lifetime Herd features plus self-hosting. Optional seller-set donation rate. No platform cut of sales; card processing is the seller's own Stripe/Square account at standard rates.

## Target Audience

**Target companies:** Very small food businesses — family farms, ranches, homesteads, raw-milk dairies, bakers, jam/honey/preserve makers, soap & candle makers, wool/fiber producers, flower farms, farmers-market vendors, CSAs. Typically owner-operated, thin margins, local customer base. Secondary audience: buyers who want local food and food-freedom-aligned shopping, including the Bitcoin/Nostr community.
**Decision-makers:** The owner themselves — farmer, rancher, maker. No committee, no IT department.
**Primary use case:** Take orders online from a local customer base without paying platform fees or rent, and without a platform being able to take the store away.
**Jobs to be done:**

- "Let my market/CSA customers pre-order and pay online without me giving up 10% or $39+/mo."
- "Give me a store I actually own — listings, reviews, customer relationships — that no policy change can delete."
- "Let me get paid how I want: Bitcoin, cards, Venmo, cash at pickup."
  **Use cases:**
- A farmers-market vendor takes pre-orders for Saturday pickup.
- A ranch sells variable beef shares direct, with Lightning or card checkout.
- A homesteader sells soap and eggs from a branded stall on their own domain.
- An AI agent (buyer-side) searches the catalog and purchases via MCP/UCP/CLI with L402/x402 Lightning payment.

## Personas

| Persona                              | Cares about                                                    | Challenge                                                                                     | Value we promise                                                        |
| ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Seller (owner-operator farmer/maker) | Margin, time, not getting deplatformed                         | Fees and rent eat thin margins; marketplaces can suspend them; no tech staff                  | Free real store, you own it, payments go straight to you                |
| Buyer (local food / food freedom)    | Real food from people they know, privacy, paying how they want | Grocery supply chain is opaque; marketplaces track them; some products are hard to buy openly | Direct relationship with the producer, encrypted comms, Bitcoin or card |

## Problems & Pain Points

**Core problem:** Selling local food online means renting someone else's platform — monthly fees before the first sale, stacked transaction fees past 10%, and constant exposure to policy changes, category bans, and frozen accounts.
**Why alternatives fall short:**

- Shopify: monthly rent plus paid apps, nothing built for local food, your store lives on their terms.
- Etsy: fee stack quietly passes 10% of each order; buyers remember Etsy, not you; suspensions with no human appeal.
- Barn2Door / Local Line / GrazeCart: genuinely farm-aware but $950-$1,800+ in year one, annual commitments, still rented silos.
- Square Online: free-ish card store but generic, no marketplace discovery, restricted-category funds holds.
- Facebook Marketplace: free reach but no store, no branding, no reorder flow, moderation bots flag food as contraband.
  **What it costs them:** Hundreds to thousands per year in fees on already-thin farm margins; customer lists they can't export; businesses ended by a policy email.
  **Emotional tension:** 77 local farms close every day while middlemen capture the margin. Frustration at gatekeepers; fear of building on rented ground; desire for sovereignty over their own livelihood.

## Competitive Landscape

**Direct:** Barn2Door ($119-299/mo + $399-599 setup; white-glove, deep farm features, but real farm money and annual lock-in), Local Line (from $79/mo; best for wholesale/B2B and food hubs; priced for volume), GrazeCart ($89/mo+; best catch-weight meat workflow; meat-first, pricey, unpublished upper tiers).
**Secondary:** Shopify (from $39/mo + apps; unmatched ecosystem, scales to national brands, but rent + their-rules ownership), Square Online (free card store + POS unity; generic, no discovery, ToS exposure), Etsy (built-in buyer traffic for craft; 10%+ fee stack, no customer list).
**Indirect:** Facebook Marketplace (free local reach, no store at all), BeefMaps (beef-only directory, no checkout), and "cash at the market only" (no online presence).
**How each falls short:** every one is either expensive, generic, rented, or not a store. None combines free + owned + local-food context. (Full per-competitor pricing/wins/gaps live in `utils/seo/model.ts` — the /vs pages are the canonical, dated comparison content.)

## Differentiation

**Key differentiators:**

- Free forever: unlimited listings, no mandatory transaction fees, ever. Optional donation, never a cut.
- Ownership: listings, reviews (NIP-85), and customer relationships live on Nostr relays — portable, not deletable by us; self-hosting available at Wrangler.
- Payment freedom: Bitcoin (Lightning + Cashu) with zero fees, seller's own Stripe or Square (incl. Apple Pay), manual fiat (Venmo, Cash App, Zelle, cash). Seller-owned LNbits nodes for agent-paid checkouts.
- Local-food context built in: pickup/local delivery, marketplace discovery, seller-hosted communities, reviews that carry to other Nostr marketplaces.
- Agent-ready commerce: MCP server, UCP (the Google/Shopify-backed standard), zero-dep CLI, L402/x402 Lightning payment flows, plus a built-in AI seller assistant that runs the stall through chat.
- Honest marketing: the /vs pages state where each competitor wins, with dated, checked pricing.
  **How we do it differently:** the store is data on an open protocol first and a website second; the platform is a lens and toolkit over data the seller owns, not the landlord of it.
  **Why that's better:** no fee drag on thin margins, no existential platform risk, payments settle directly to the seller, and leaving costs nothing because there is nothing to leave.
  **Why customers choose us:** zero cost to start, no deplatforming risk, Bitcoin-native payments, and local-food-specific defaults — without giving up cards, email automation, custom domains, or shipping labels when they upgrade.

## Objections

| Objection                                   | Response                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "There aren't buyers on a new marketplace." | The free stall is a real storefront first — your link, your domain. Marketplace discovery is additive, and at $0 there's no reason not to run it beside your current channel. |
| "I don't know Bitcoin or Nostr."            | You don't need to. Sign in with email, Google, or Apple; take cards through your own Stripe/Square. The protocol is underneath, not in your face.                             |
| "Will my buyers trust it?"                  | Encrypted order messaging, portable reviews, optional escrow, and a direct relationship with you — the trust is between buyer and farmer, where it belongs.                   |

**Anti-persona:** Venture-scale CPG brands shipping nationally that need a deep app ecosystem (Shopify's real win), wholesale food hubs needing complex B2B price lists (Local Line's real win), and sellers who want the platform to supply all their traffic and will pay 10%+ for it (Etsy's real win).

## Switching Dynamics

**Push:** Fee stacks past 10% (Etsy), $60-100/mo before selling anything (Shopify + apps), frozen accounts and category bans, moderation bots flagging jam as contraband, no customer list to take when leaving.
**Pull:** $0 to start with unlimited listings, ownership of store and relationships, Bitcoin-native payments with zero platform fee, local discovery, one-click Shopify product import, 30-day Herd trial with no card.
**Habit:** Existing store and SEO equity elsewhere, "everyone uses Shopify/Etsy," setup time already sunk, market-booth workflow that sort of works.
**Anxiety:** "Will anyone find me there?", "Is this Nostr thing weird or hard?", "What if Self-sown goes away?" (answer: your listings live on relays; Wrangler can self-host; leaving costs nothing).

## Customer Language

**How they describe the problem:**

- GAP: needs verbatim customer quotes from seller conversations, Nostr mentions, support inquiries.
  **How they describe us:**
- GAP: needs verbatim customer language.
  **Words to use:** stall, food freedom, permissionless, "your store belongs to you," "no platform fees," local food, artisan goods, producer, direct, own, relay (when technical), "sell to your community."
  **Words to avoid:** raw-milk-first framing (positioning is local food + artisan goods broadly — raw milk is a use case, not the brand); hype words (seamless, unlock, empower, supercharge, magic, revolutionary); exclamation marks in UI text; "platform fees" without "from us" precision.
  **Glossary:**
  | Term | Meaning |
  |------|---------|
  | Stall | A seller's storefront (/stall/<slug> or their own domain) |
  | Herd | The paid membership tier ($21/mo or $168/yr) |
  | Wrangler | One-time $2,100 lifetime tier, adds self-hosting |
  | Nostr | Open protocol the marketplace data lives on |
  | Relay | Servers that store/serve Nostr events; sellers' listings live there |
  | Lightning / Cashu | Bitcoin payment rails (instant / ecash) |
  | NWC | Nostr Wallet Connect — buyer's wallet pays invoices directly |
  | MCP / UCP | AI-agent interfaces to the catalog and checkout |
  | NIP | Nostr Implementation Possibility (protocol standard) |

## Brand Voice

| Attribute                               | Means                                                              | Doesn't mean                           | Example line                                                                              |
| --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Honest to a fault                       | We say where competitors win and date our pricing checks           | False modesty or hedging everything    | "Full disclosure: we build Self-sown, so yes, we're biased."                              |
| Plain-spoken                            | Short concrete sentences, real numbers, farm vocabulary            | Corporate marketing voice or jargon    | "77 local farms close every day. Every. Single. Day."                                     |
| Sovereignty-minded                      | Ownership, freedom, and censorship-resistance as concrete benefits | Abstract crypto-bro sloganeering       | "Your listings and your customer relationships live on open relays, not in our database." |
| Warm to producers, sharp to gatekeepers | Respect for farm work; blunt about rent-seekers                    | Attacking individual farmers or buyers | "Pick based on which business you actually are."                                          |

**Tone by context:**

- Support: patient, step-by-step, assumes no Nostr/Bitcoin knowledge.
- Launch: direct and factual; the feature and what it costs, no hype adjectives.
- Errors: plain statement of what happened and what to do; never cutesy.
- Sales: lead with the free tier and ownership; name the tradeoffs before being asked.
- Social: founder voice allowed to be sharper and more ideological (manifesto register).
  **Terms we own:** stall, Herd, Wrangler, food freedom, "Your farm. Your stall."
  **Never use (and why):** seamlessly / unlock / empower / supercharge (AI-slop marketing register, removed in the Oct 2026 copy pass); exclamation marks in UI (shouting); "raw milk platform" as the brand (narrower than the actual market).

## Proof Points

**Metrics:** GAP: no public usage metrics captured yet (sellers, GMV, listings).
**Customers:** Showcase stalls on the landing page: Free Milk (self-sown.com/stall/freemilk) and Naughty Goat Co. (naughtygoat.co, custom domain).
**Testimonials:** GAP: needs verbatim testimonials.

> "[quote]" — [who]
> **Value themes:**
> | Theme | Proof |
> |-------|-------|
> | Zero-cost start | Free plan with unlimited listings; comparison pages with dated competitor pricing |
> | Real ownership | Listings/reviews as Nostr events; Shopify import; self-hosting at Wrangler |
> | Payment freedom | Lightning + Cashu + Stripe + Square + manual fiat; zero-fee Bitcoin checkout |
> | Agent-ready | MCP + UCP + CLI + L402/x402; built-in AI seller assistant |

## Goals

**Business goal:** Grow the number of active sellers with live stalls and orders flowing.
**Conversion action:** "Start selling" → /onboarding/new-account?flow=seller (secondary: browse the marketplace).
**Current metrics:** GAP: not captured here.

## Learnings

_Decisions and tested lessons. Newest first. Keep it to about 20 active entries._
| Date | Learning | Evidence | Applies to | Status |
|------|----------|----------|------------|--------|
| 2026-10-30 | Position as local food + artisan goods broadly; raw-milk-first framing is dismissed as the brand lead (kept as one audience/use case) | Founder direction; reflected in FAQ, llms-full.txt, and /best guides covering 10 audiences | All positioning, copy, SEO, ads | active |
| 2026-10-30 | Comparison content must stay honest: every /vs page names where the competitor wins, with dated pricing ("checked October 2026") | utils/seo/model.ts COMPETITORS + PRICING_DISCLAIMER convention | competitors, copywriting, ai-seo | active |

## Changelog

_Newest first. One line per revision: what changed and why._

- v1 (2026-10-30) — Initial context, auto-drafted from README, landing, FAQ, manifesto, llms-full.txt, and the /vs content model.
