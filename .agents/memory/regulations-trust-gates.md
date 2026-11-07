---
name: Regulation trust gates (golden eval + legal framing + attorney sign-off)
description: The durable gate decision for the regulation wedge — no unreviewed answers, ever; details live in the docs.
---

The regulation wedge's trust gates (docs/producer-platform-plan.md, P0) rest on one durable decision: **the chat serves nothing until every golden answer has documented attorney/FTCLDF/extension sign-off, and there is deliberately no env override** — a settable flag would be a gate that isn't one. The golden eval enforces CI drift protection, the launch gate closes the page and API while any case is pending, sign-off requires a named reviewer + date per case (unfakeable by flipping a status field), and model output is rejected for advisory phrasing ("you should…"), not just prompt-instructed against it — a prompt is a request, not a guarantee.

**Why:** a wrong food-law answer gets sellers fined; the plan requires the gates BEFORE launch, and the first completion review caught that framing alone doesn't enforce them.

**How to apply:** never add an override or bypass to the launch gate; any new golden case, corpus row, or answer surface must go through the same eval and gate. Mechanics (file paths, the review packet, engagement log) live in docs/regulations-attorney-review.md and the wedge decision doc — check there, not here.
