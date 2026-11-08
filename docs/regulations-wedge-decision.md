# Regulation-graph wedge decision (P0, layer 1: corpus)

**Date:** 2026-11-07 · **Status:** ENCODED, **PENDING ATTORNEY REVIEW** — see "Review status" below.

## Expansion (2026-11-07): + Oregon, Idaho, California, Texas

First batch of the P2 50-state expansion: the rest of the PNW (OR, ID) plus California and Texas. Same encoding discipline as the wedge: verbatim excerpts from primary sources, per-channel rows, `last_verified_at` on every row, all rows **PENDING ATTORNEY REVIEW**. Notes for the reviewer:

- **Oregon** (ORS chapters 616/621/632 on oregonlegislature.gov + ODA FAQ PDF): cottage food is a residential-dwelling *exemption* (ORS 616.723, $50k CPI-adjusted cap, internet/mail-order expressly allowed, limited retail/wholesale paths); raw milk is the small-scale on-farm exception (ORS 621.012) plus the retail cow-milk ban (ORS 621.116); eggs have a producer-direct license exemption (ORS 632.715(1)(a)). No OR herdshare statute was found — herdshare questions in OR answer "unknown" by design.
- **Idaho** (Idaho Code 37-1101, IDAPA 02.04.13, ISDA/CDH guidance): Idaho has **no cottage food statute** — the framework is health-district guidance under the Idaho Food Code, so those rows are tier `agency_guidance` citing the Central District Health FAQ. Raw milk is doubly lawful: registered herdshares (I.C. § 37-1101) and ISDA raw-milk permits with in-state-only sales (IDAPA 02.04.13). Eggs use the ISDA <300-bird small-flock exemption (agency guidance).
- **California** (leginfo.legislature.ca.gov + CDFA/CDPH program pages): Class A/B cottage food (HSC 113758/114365/114365.2) with CDPH's 2025 CPI-adjusted caps ($86,206 / $172,411); "direct sale" is defined as a transaction *within the state*, so interstate is prohibited. Raw milk is retail-legal with a CDFA market milk permit (FAC § 33222). Eggs have **no** small-flock exemption — CDFA ESQM registration is universal.
- **Texas** (statutes.capitol.texas.gov + 25 TAC): cottage food chapter 437 as amended by **SB 541 (effective 2025-09-01)** — cap raised to $150,000, TCS foods now allowed with extra labeling, wholesale allowed only to registered cottage food vendors. Raw milk requires the Grade A Raw for Retail Permit (25 TAC 217.31): on-farm sales and direct delivery only — farmers-market, retail-store, and wholesale channels are not authorized. Eggs have an own-flock ungraded exemption (Ag. Code § 132.002).
- `effective_date` for the new states is null except where verified (SB 541 rows: 2025-09-01; federal rules carried over) — filling them from enrolled session laws is reviewer follow-up, as is OR/ID/CA/TX attorney review generally.

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
3. **Colorado citation host**: the official C.R.S. public access (LexisNexis portal via leg.colorado.gov) is not deep-linkable per section. CO rows cite `law.justia.com`, which reproduces official statute text. **Partially resolved 2026-11-07**: every CO excerpt was re-checked verbatim against justia's 2025 C.R.S., and the § 25-4-1614 excerpts were additionally cross-checked against the official session-law rendering (HB26-1033, ch. 375, restates the amended subsections) — all matched. The reviewer should still spot-check §§ 25-5.5-117 and 35-21-104/-105 against the official C.R.S. portal.
4. **Known pending change**: Colorado HB26-1033 ("Tamale Act") — **confirmed 2026-11-07** as ch. 375, Session Laws of Colorado 2026 (approved 2026-06-04). Per its Section 8, the act took effect on passage except the § 25-4-1614 and § 35-36-102 amendments, which take effect **2027-01-01**. Re-encode the CO cottage_food rows when they land — including the flip of the per-product revenue cap from net to **gross** revenue — this is exactly the P3 change-monitoring use case.
5. **`effective_date: null` rows — resolved 2026-11-07.** Filled from official sources: RCW 15.36.051 → 2015-10-09 (ESHB 2128, 2015 3rd sp.s. c 27, enrolled session law); RCW 69.22.010 → 2015-07-24 (HB 1622, 2015 c 203, enrolled session law); 21 CFR 1240.61 → 1987-09-09 (52 FR 29509, Docket 81N-204C, effective date stated in the rule); 21 CFR 118.1 → 2009-09-08 (74 FR 33030, per the Federal Register document record; compliance for 3,000+ hen producers was 2010-07-09). The two WSDA agency-guidance rows keep `effective_date: null` because guidance documents carry no statutory effective date.

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
| OR | cottage_food | farmers_market, on_farm, online_intrastate, online_interstate, retail, wholesale | 13 | ORS 616.723, ODA Cottage Food FAQ |
| OR | raw_milk | on_farm, farmers_market, retail, online_intrastate, wholesale, online_interstate | 6 | ORS 621.012, ORS 621.116, 21 CFR 1240.61 |
| OR | eggs | farmers_market, on_farm, online_intrastate, retail, wholesale, online_interstate | 7 | ORS 632.715/.741, 21 CFR 118.1 |
| ID | cottage_food | farmers_market, on_farm, online_intrastate, online_interstate, retail, wholesale | 7 | CDH Cottage Foods FAQ (Idaho Food Code framework) |
| ID | raw_milk | on_farm, farmers_market, online_intrastate, retail, wholesale, herdshare, online_interstate | 7 | I.C. § 37-1101, IDAPA 02.04.13, 21 CFR 1240.61 |
| ID | eggs | farmers_market, on_farm, online_intrastate, retail, wholesale, online_interstate | 7 | ISDA Egg Candlers & Distributors (<300 birds), 21 CFR 118.1 |
| CA | cottage_food | farmers_market, on_farm, online_intrastate, retail, wholesale, online_interstate | 9 | HSC 113758, 114365, 114365.2, CDPH 2025 caps |
| CA | raw_milk | retail, on_farm, farmers_market, online_intrastate, wholesale, online_interstate | 6 | CDFA Raw Milk Requirements (FAC §§ 33222, 35781, 35891), 21 CFR 1240.61 |
| CA | eggs | farmers_market, on_farm, retail, wholesale, online_intrastate, online_interstate | 7 | CDFA ESQM (no small-flock exemption), 21 CFR 118.1 |
| TX | cottage_food | farmers_market, on_farm, online_intrastate, online_interstate, wholesale, retail | 16 | HSC ch. 437 (SB 541, eff. 2025-09-01) |
| TX | raw_milk | on_farm, online_intrastate, farmers_market, retail, wholesale, online_interstate | 6 | 25 TAC 217.31 (Grade A Raw for Retail), 21 CFR 1240.61 |
| TX | eggs | farmers_market, on_farm, online_intrastate, retail, wholesale, online_interstate | 7 | Ag. Code §§ 132.002, 132.021, 4 TAC 15.2, 21 CFR 118.1 |

Total: 160 rules + 24 agency contacts (state default + one per category per state). Every lawful direct channel carries the full requirement set (permit/course, product list, cap, labeling) — an intrastate online sale with direct delivery has the same conditions as a farmers-market table.

**Engine contract (review-hardened):** when a question resolves state + category but no channel, the engine answers only if every covered channel agrees on the decision; if channels disagree (e.g. direct sales conditional, wholesale prohibited) it asks for the channel instead of aggregating to a most-restrictive verdict that would call a lawful direct sale "prohibited."

Headline decisions the matrices encode (all verbatim-cited in the corpus):

- **WA cottage food**: conditional — 2-year WSDA permit, $35,000/yr gross cap per residence (RCW 69.22.050), approved non-potentially-hazardous products only (WAC 16-149-120), home-kitchen disclaimer label; **internet/mail-order and out-of-state retail prohibited** (RCW 69.22.020(4)); no wholesale/third-party retail.
- **WA raw milk**: conditional — legal at retail/on-farm/farmers-market/wholesale only with the $250/yr milk processing plant license (RCW 15.36.051) + statutory warning label (WAC 16-101-800); herdshares are treated as a sale and need the same license (WSDA); **interstate prohibited** (21 CFR 1240.61).
- **WA eggs**: conditional — egg handler/dealer license required even for producers selling their own eggs (RCW 69.25.050, $30/yr); FDA egg rule at 3,000+ layers for interstate.
- **CO cottage food**: conditional — broad product list incl. pickled produce (pH ≤ 4.6) and ≤250 doz eggs/mo; food-safety course; **$10,000 net revenue cap per product per year**; label + point-of-sale placard disclaimers; in-state direct delivery only, **no interstate, no resale**.
- **CO raw milk**: **prohibited at retail/farmers-market/on-farm/online**; lawful only via registered cow/goat shares with written bill-of-sale + boarding contract, warning, and herd-health test results (C.R.S. § 25-5.5-117).
- **CO eggs**: conditional — <250 dozen/month own-production sales on-farm/farmers-market/CSA are license-exempt with transport + safe-handling labeling (§ 35-21-105); every other channel needs a CDA dealer's license (§ 35-21-104).

## Review status

**PENDING — no food-law attorney or FTCLDF reviewer is lined up yet.** Per the plan this is the scarce resource and a launch gate: the golden answer set must be attorney-validated before the chat ships. The corpus rows are marked PENDING ATTORNEY REVIEW at file level; each row's `last_verified_at` records when the source was last re-read (2026-11-07), and attorney sign-off should advance it. The review packet — golden set, reviewer checklist, and engagement log — lives in `docs/regulations-attorney-review.md`; the CI eval harness that enforces the golden set is `__tests__/utils/regulations/golden-answers.test.ts` over `utils/regulations/golden-answers.ts`.
