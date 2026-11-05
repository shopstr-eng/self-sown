# Producer Platform Plan (canonical)

**Audience: farmers, local food producers, and food-based DTC brands** — not just farmers. Every tool below is scoped against all three groups.

Original overview (2026-11-05, user-provided): `attached_assets/Pasted-The-concept-Not-a-chatbot-that-knows-food-law-those-hal_1793867946625.txt`. This document expands it; the original text is preserved there and governs wherever the two disagree on the regulation-graph concept.

## The concept

Not "a chatbot that knows food law" — those hallucinate and get people fined. A **regulation graph with an agent front-end**: every jurisdiction × product category × sales channel as structured, citable data, with an LLM that retrieves and explains but never decides. Then wire compliance into the marketplace so it happens at listing time, not after a cease-and-desist.

## Sequencing rule

**Regulatory help ships first.** It is the moat — nobody else has a citable food-regulation graph, and it makes every later tool smarter. Production and finance tooling follow.

## The ambition principle (deeper, not bigger)

Every producer tool on the market (Farmbrite, AgSquared, QuickBooks, spreadsheets) asks the producer to type everything in. **Self-sown already sees the money (Stripe/Square/Cashu settlement) and the inventory (listings, orders).** Our tools start mostly pre-filled; the producer confirms instead of entering. Each tool also feeds the others: lot codes serve FSMA traceability, yield data serves unit economics, on-platform sales serve compliance caps. That compounding is the whole strategy — features that don't compound don't make the cut.

## Phasing

### P0 — Regulation graph + chat (the wedge)
Per the original overview: corpus (2 states × 3 categories, chosen from where sellers actually are; raw sources only; every row cited with statute excerpt, effective date, last-verified date) + deterministic rule engine (data decides, LLM explains; fail-closed, loud on unknown) + RAG via pgvector in the existing Postgres + confidence tiers (statute-verified / agency-guidance / unknown → agency contact, never a guess).

Trust gates before launch (also per the overview): golden-Q&A eval harness in CI, "legal information, not legal advice" framing + ToS update, attorney/FTCLDF review of the golden answer set.

### P1 — Listing-time compliance
Seller lists "raw milk, ships interstate" → flagged before publish. Jam in Colorado → label requirements + sales cap surfaced in the form. **Plus the cross-over only we can build: cottage-food sales caps tracked from actual on-platform sales** — warn at 80%, act at the cap per state rule. Competitors can publish the cap; only we can enforce it against real numbers.

### P2 — Producer operating system
- **Finances (all three audiences):** settlement-fed books — every sale, payout, platform fee, and Shippo label already has a ledger entry, so the P&L is generated, not entered. Per-enterprise P&L (per animal / per crop / per product line). Schedule F-ready export for farmers; COGS and inventory reports for DTC brands. Unit economics (cost per dozen eggs, per lb of cheese) join yield data to settlement data.
- **Production & seasonal tracking:** livestock breeding records with species gestation calendars, expected-birth alerts, lactation/yield curves, lineage (farmers); planting/harvest windows and yield per bed (growers); batch production runs with lot codes (producers & DTC brands) — lot codes plug straight into the graph's FSMA traceability rules.
- **Document vault + renewal reminders** on the existing flow/email engine: license expirations, water-test schedules, annual permits.
- **50-state corpus expansion**, state by state.
- Mobile is the capture surface: barn, field, and market-stall entry with photos; the Expo app already exists.

### P3 — Change monitoring + public MCP
Watch statute/regulation pages, diff on change, push-notify affected sellers ("the law changed in your state" — a retention feature nobody can copy without the graph). Public food-law MCP server makes Self-sown the infrastructure layer other agents query.

### P4 — Market intelligence (the data network effect)
Anonymized aggregate benchmarks from real marketplace transactions: what pastured eggs actually sell for in Colorado, by season and channel. Pricing guidance from ground truth, not surveys. Nobody without a marketplace can build this.

## What we'd need to start (unchanged from the overview)
- A legal reviewer (one food-law attorney or FTCLDF relationship) — the scarce resource.
- The wedge decision — which 2 states × 3 categories first (seller base data answers this).
- Budget — LLM calls (Anthropic integration exists), plus ~40–80 hours of legal-adjacent research for the wedge matrices.
- ToS/disclaimer update — small but load-bearing.

## Explicit non-goals for now
Feed/supply marketplaces, equipment, land matching, lending — anything that doesn't compound with the graph, the ledger, or the listings.
