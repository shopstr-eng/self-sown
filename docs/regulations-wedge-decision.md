# Regulation-graph wedge decision (P0, layer 1: corpus)

**Date:** 2026-11-07 · **Status:** ENCODED, **PENDING ATTORNEY REVIEW** — see "Review status" below.

## The wedge: Washington + Colorado × cottage food, raw milk, eggs

Chosen from where sellers actually are, per the plan (`docs/producer-platform-plan.md`, P0).

### Data basis

Queried the seller base (Postgres `product_events` / `profile_events` / `authed_sellers`; latest version per `(pubkey, d-tag)` — the dedup rule from `.agents/memory/per-seller-product-dedup.md`):

- 12 sellers, 35 current products in the development database.
- **Washington is the dominant US food-seller cluster**: a licensed raw goat dairy with 12+ current listings and 8 pickup locations around Seattle/Mount Vernon WA (raw milk, cheese), a second WA farm seller with farmers-market pickup (cottage-food-style preserved goods), and laying-hen/poultry listings from WA.
- Product categories present in the base map directly onto three of the plan's candidate categories: **raw milk** (multiple raw goat milk listings), **eggs** (laying hens/poultry — the egg-adjacent farm cluster), **cottage food** (preserves/confections). Meat and acidified foods had weaker seller signal and are deferred.
- Non-US sellers (UK dairy, Jaipur) are out of scope for a US-state corpus.

### Flags the reviewer/user must know

1. **Production seller data was unreachable at decision time.** The production Neon endpoint was suspended ("endpoint has been disabled") and there is no Neon API key in the environment, so the distribution above comes from the development database. **Re-validate the second state against production seller data before launch.**
2. **Washington is data-confirmed; Colorado is the second state for two reasons**: (a) the canonical plan's own worked examples are Colorado ("Jam in Colorado", "pastured eggs in Colorado"), and (b) CO maximizes decision-space contrast against WA — raw milk is retail-legal-but-licensed in WA and retail-illegal/herdshare-only in CO, which exercises the engine's prohibited/conditional paths from day one.
3. **Colorado citation host**: the official C.R.S. public access (LexisNexis portal via leg.colorado.gov) is not deep-linkable per section. CO rows cite `law.justia.com`, which reproduces official statute text; the attorney reviewer must confirm excerpts against the official C.R.S.
4. **Known pending change**: Colorado HB26-1033 ("Tamale Act") passed in 2026, effective **2027-01-01** (per CDPHE cottage foods page). Re-encode the CO cottage_food rows when it lands — this is exactly the P3 change-monitoring use case.
5. **`effective_date: null` rows** (WA milk license statutes RCW 15.36.021/.051, the two eCFR rows, RCW 69.22.010): the most recent amendment's exact effective date was not verifiable from the primary source page; the attorney reviewer should confirm or fill these.

## Corpus schema (enforcement)

`utils/regulations/schema.ts` (`corpusRuleSchema`) — a row without a real citation is invalid at three layers:

- **zod** (`strict`): `citation_url` must be http(s), `citation_title`/`statute_excerpt` non-empty, `last_verified_at` an ISO date, `effective_date` ISO or null; tier is `statute_verified | agency_guidance` only.
- **Postgres** (`regulation_corpus_rules`): NOT NULL + content CHECKs on citation/excerpt/last-verified.
- **CI** (`__tests__/utils/regulations/corpus.test.ts`): every row validates, ids unique, citations restricted to primary-source hosts, wedge coverage asserted.

## Encoded matrices

Source of truth: `utils/regulations/corpus/{washington,colorado,agency-contacts}.ts`, assembled and validated at module load in `utils/regulations/corpus/index.ts`. Load with `pnpm tsx scripts/seed-regulations-corpus.ts --apply` (idempotent; deterministic ids).

| State | Category | Channels covered | Rows | Key sources |
| --- | --- | --- | --- | --- |
| WA | cottage_food | farmers_market, on_farm, retail, wholesale, online_intrastate, online_interstate | 12 | RCW 69.22 (.010/.020/.030/.050), WAC 16-149-120/-130 |
| WA | raw_milk | retail, on_farm, farmers_market, online_intrastate, wholesale, herdshare, online_interstate | 12 | RCW 15.36.051/.021, WAC 16-101-800, WSDA Retail Raw Milk guide, WSDA Truth About Raw Milk Sales, 21 CFR 1240.61 |
| WA | eggs | farmers_market, on_farm, retail, wholesale, online_intrastate, online_interstate | 7 | RCW 69.25.050, 21 CFR 118.1 |
| CO | cottage_food | farmers_market, on_farm, online_intrastate, online_interstate, wholesale, retail | 16 | C.R.S. § 25-4-1614 |
| CO | raw_milk | herdshare, retail, farmers_market, on_farm, online_intrastate, online_interstate | 6 | C.R.S. § 25-5.5-117, 21 CFR 1240.61 |
| CO | eggs | farmers_market, on_farm, retail, wholesale, online_intrastate, online_interstate | 9 | C.R.S. §§ 35-21-104, 35-21-105, 21 CFR 118.1 |

Total: 62 rules + 8 agency contacts (state default + one per category per state). Every lawful direct channel carries the full requirement set (permit/course, product list, cap, labeling) — an intrastate online sale with direct delivery has the same conditions as a farmers-market table.

**Engine contract (review-hardened):** when a question resolves state + category but no channel, the engine answers only if every covered channel agrees on the decision; if channels disagree (e.g. direct sales conditional, wholesale prohibited) it asks for the channel instead of aggregating to a most-restrictive verdict that would call a lawful direct sale "prohibited."

Headline decisions the matrices encode (all verbatim-cited in the corpus):

- **WA cottage food**: conditional — 2-year WSDA permit, $35,000/yr gross cap per residence (RCW 69.22.050), approved non-potentially-hazardous products only (WAC 16-149-120), home-kitchen disclaimer label; **internet/mail-order and out-of-state retail prohibited** (RCW 69.22.020(4)); no wholesale/third-party retail.
- **WA raw milk**: conditional — legal at retail/on-farm/farmers-market/wholesale only with the $250/yr milk processing plant license (RCW 15.36.051) + statutory warning label (WAC 16-101-800); herdshares are treated as a sale and need the same license (WSDA); **interstate prohibited** (21 CFR 1240.61).
- **WA eggs**: conditional — egg handler/dealer license required even for producers selling their own eggs (RCW 69.25.050, $30/yr); FDA egg rule at 3,000+ layers for interstate.
- **CO cottage food**: conditional — broad product list incl. pickled produce (pH ≤ 4.6) and ≤250 doz eggs/mo; food-safety course; **$10,000 net revenue cap per product per year**; label + point-of-sale placard disclaimers; in-state direct delivery only, **no interstate, no resale**.
- **CO raw milk**: **prohibited at retail/farmers-market/on-farm/online**; lawful only via registered cow/goat shares with written bill-of-sale + boarding contract, warning, and herd-health test results (C.R.S. § 25-5.5-117).
- **CO eggs**: conditional — <250 dozen/month own-production sales on-farm/farmers-market/CSA are license-exempt with transport + safe-handling labeling (§ 35-21-105); every other channel needs a CDA dealer's license (§ 35-21-104).

## Review status

**PENDING — no food-law attorney or FTCLDF reviewer is lined up yet.** Per the plan this is the scarce resource and a launch gate: the golden answer set must be attorney-validated before the chat ships. The corpus rows are marked PENDING ATTORNEY REVIEW at file level; each row's `last_verified_at` records when the source was last re-read (2026-11-07), and attorney sign-off should advance it.
