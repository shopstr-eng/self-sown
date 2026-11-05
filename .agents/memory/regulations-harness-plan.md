---
name: Regulations harness plan (canonical)
description: The user's own overview doc for the local-food-regulations agent harness — phasing, architecture principles, and the P0 scope. Source of truth: attached_assets/Pasted-The-concept-Not-a-chatbot-that-knows-food-law-those-hal_1793867946625.txt
---

The canonical plan text lives at `attached_assets/Pasted-The-concept-Not-a-chatbot-that-knows-food-law-those-hal_1793867946625.txt` (user-provided 2026-11-05). It was lost once to context compaction — consult the file, not memory of a summary.

**Why:** the concept is NOT "a chatbot that knows food law." It's a regulation graph (jurisdiction × product category × sales channel as structured, citable data) with an agent front-end that retrieves, never improvises. Compliance should happen at listing time.

**How to apply (load-bearing principles):**
- Deterministic rule engine decides; the LLM only interprets/explains. Schema-validated, fail-closed, loud on unknown.
- Corpus rows are raw sources only (state statutes, eCFR, state ag dept rules/guidance PDFs — never blog summaries) and every row carries citation URL, statute excerpt, effective date, last-verified date.
- Confidence tiers on every answer: statute-verified / agency-guidance / unknown — and unknown means "here's the agency contact," never a guess.
- RAG over the corpus with pgvector in the existing Postgres (no new infra class); Anthropic integration already exists.
- Phasing: **P0** corpus + rule engine + chat for the wedge (2 states × 3 categories, chosen from where sellers actually are) → **P1** listing-time integration → **P2** document vault, renewal reminders, 50-state expansion → **P3** change monitoring + public MCP server.
- Before-launch trust gates: "legal information, not legal advice" framing ("the statute says X", never "you should do Y"), ToS update, attorney review loop for the golden answer set (FTCLDF / state extension offices are natural partners), and a golden-QA eval harness in CI that must pass before corpus or model changes ship (same drift-guard philosophy as the Tap to Pay copy test).
