---
name: Regulation answer safety contract
description: The food-regulation chat's fail-closed rules — engine decides, LLM only explains, citations and decision wording are deterministic.
---

The wedge regulation chat exists to never hallucinate food law. Its durable safety rules:

- The compliance decision comes only from the deterministic engine over schema-validated corpus rows; the decision sentence served to users is composed in code, never by the model. The model may only write a supplementary body, validated for citation membership (engine-evaluated rules only — retrieved context is background, never citable) and decision contradictions, with a deterministic template as the floor.
- Ambiguity fails closed: multiple mentioned states, generic product words ("cheese" ≠ raw milk), and bare "online/ship" (intra- vs interstate unknown) all resolve to clarification, never a guessed slot. The engine never extrapolates a decision to an uncovered channel.
- Optional pgvector setup must never run inside the shared schema-DDL transaction: a failed CREATE EXTENSION aborts it and the COMMIT becomes a silent rollback while bootstrap reports success. Run it post-commit on a fresh connection; keep the full-text column in the shared schema string so both install paths get it.

**Why:** a wrong food-law answer gets sellers fined; fail-closed is the wedge's core promise (docs/producer-platform-plan.md).

**How to apply:** any change to the corpus schema, engine, parser, or explain seam must preserve these properties and their regression tests. Known open hardening (flagged at completion review): an answered question with no resolved channel should scope its answer to the channels actually evaluated (or clarify), and mixed-channel questions should not silently take the first parser match; model bodies are phrase-checked but not groundedness-checked, so prefer template output when in doubt.
