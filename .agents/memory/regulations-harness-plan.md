---
name: Regulations harness / producer platform plan (canonical)
description: The user's plan for the food-regulation graph + producer tooling. Canonical expanded doc is docs/producer-platform-plan.md; original user overview is in attached_assets.
---

Canonical plan: **docs/producer-platform-plan.md** (expanded 2026-11-05 per user direction). Original user overview preserved at `attached_assets/Pasted-The-concept-Not-a-chatbot-that-knows-food-law-those-hal_1793867946625.txt` and governs the regulation-graph concept where they differ. The plan was once lost to context compaction — read the files, never a remembered summary.

**Why:** the concept is NOT "a chatbot that knows food law." It's a regulation graph (jurisdiction × category × channel as structured, citable data) with an agent front-end that retrieves, never improvises — plus producer tooling that compounds with it.

**How to apply (load-bearing rules):**
- **Audience is farmers AND local food producers AND food-based DTC brands** (user's explicit correction) — scope every tool against all three.
- **Sequencing: regulatory help ships FIRST** (user's explicit rule), then finance/production tooling.
- Deterministic rule engine decides; the LLM only explains. Schema-validated, fail-closed, loud on unknown. Confidence tiers: statute-verified / agency-guidance / unknown → agency contact, never a guess.
- Corpus rows: rawest sources only (statutes, eCFR, state ag PDFs); every row carries citation URL + statute excerpt + effective + last-verified dates.
- Ambition principle: tools start pre-filled from data the platform already has (Stripe/Square/Cashu settlement, listings, Shippo labels) — producer confirms, never re-enters; every tool must compound with the graph/ledger/listings or it's cut.
- Phasing: **P0** corpus + rule engine + chat (wedge = 2 states × 3 categories from seller data) → **P1** listing-time compliance + cottage-food cap tracking from real sales → **P2** finances (settlement-fed books, Schedule F / COGS) + production & seasonal tracking (breeding/yield, batch lot codes) + vault/reminders + 50-state → **P3** change monitoring + public MCP → **P4** market-intelligence benchmarks.
- Wedge DECIDED 2026-11-07: **WA + CO × cottage_food, raw_milk, eggs**. WA is data-confirmed (dev seller DB: raw goat dairy cluster); CO came from plan examples + max decision-space contrast because the production Neon endpoint was suspended — re-validate state #2 against prod before launch. All rows PENDING ATTORNEY REVIEW — no reviewer lined up (flagged to user). CO statute citations use law.justia.com (official C.R.S. portal not deep-linkable) — attorney must confirm excerpts against the official C.R.S.
- Corpus expansion conventions (learned at batch-2 review): the engine merges EVERY row in a state×category×channel slot into one answer — when a state's exemptions split by product (WI pickle bill vs home-bakers ruling), encode ONE product-scoped row per channel, never parallel exemption rows; never assert a channel-wide prohibition from a source covering only some products (prefer conditional + agency contact); tier agency_guidance where the framework is guidance not statute; effective_date null unless the source page shows one; herdshare rows only with a citable source. Production Neon seller-density check was still suspended for batch 2 (NY/PA/OH/WI picked on public producer density) — re-validate ordering against prod before launch.
- Trust gates before launch: golden-Q&A eval harness in CI, "legal information, not legal advice" framing + ToS, attorney/FTCLDF review of the golden set (scarce resource — flag if missing).
