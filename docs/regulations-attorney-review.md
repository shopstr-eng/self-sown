# Regulation wedge — attorney review packet

**Status: PENDING — no reviewer engaged yet. This is a launch gate** (docs/producer-platform-plan.md, P0 trust gates): the regulation chat must not ship to users until the golden answer set below has documented sign-off from a food-law attorney, the Farm-to-Consumer Legal Defense Fund (FTCLDF), or a state extension-office reviewer.

## What needs review

1. **The corpus matrices** — `utils/regulations/corpus/{washington,colorado,agency-contacts}.ts`, summarized in `docs/regulations-wedge-decision.md` (headline decisions table). Every row carries a verbatim statute excerpt, citation URL, effective date, and last-verified date.
2. **The golden answer set** — `utils/regulations/golden-answers.ts`. Each case pins one seller question to the answer the matrices say it must get; CI (`__tests__/utils/regulations/golden-answers.test.ts`) fails if any corpus or engine change breaks one. The questions below are exactly what the harness asserts.

## Golden answer set (what CI enforces)

| #   | Question                                                | Expected answer                                                                                        | Source matrix                     |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1   | Can I sell jam at a farmers market in Washington?       | Conditional — WSDA cottage food permit + $35,000/yr gross cap + labeling                               | RCW 69.22 (.050, .020)            |
| 2   | Can I ship my jam to other states from Washington?      | Prohibited                                                                                             | RCW 69.22.020(4)                  |
| 3   | Can I sell raw milk at a farmers market in Washington?  | Conditional — $250/yr milk processing plant license + statutory warning label                          | RCW 15.36.051, WAC 16-101-800     |
| 4   | Can I sell raw milk through a herd share in Washington? | Conditional — WSDA treats shares as a sale; license still required                                     | WSDA "Truth About Raw Milk Sales" |
| 5   | Can I ship raw milk to other states from Washington?    | Prohibited                                                                                             | 21 CFR 1240.61                    |
| 6   | Can I sell eggs at a farmers market in Washington?      | Conditional — $30/yr egg handler/dealer license                                                        | RCW 69.25.050                     |
| 7   | Can I sell jam at a farmers market in Colorado?         | Conditional — food-safety course + $10,000 net revenue cap per product + label/placard                 | C.R.S. § 25-4-1614                |
| 8   | Can I sell jam online within my state in Colorado?      | Conditional — direct producer-to-consumer delivery only                                                | C.R.S. § 25-4-1614                |
| 9   | Can I sell my jam in grocery stores in Colorado?        | Prohibited — no resale                                                                                 | C.R.S. § 25-4-1614                |
| 10  | Can I sell raw milk at a farmers market in Colorado?    | Prohibited                                                                                             | C.R.S. § 25-5.5-117               |
| 11  | Can I sell raw milk through a herd share in Colorado?   | Conditional — CDPHE registration, written bill of sale + boarding contract, warning, herd-health tests | C.R.S. § 25-5.5-117               |
| 12  | Can I sell eggs at a farmers market in Colorado?        | Conditional — license-exempt under 250 dozen/month own-production                                      | C.R.S. § 35-21-105                |
| 13  | Can I sell jam in Colorado? (no channel)                | Must ask which channel — direct and resale channels disagree                                           | Engine fail-closed contract       |
| 14  | Can I sell raw milk in Texas?                           | Unknown — no corpus; agency contact path, never a guess                                                | Fail-closed contract              |
| 15  | Can I sell meat at a farmers market in Washington?      | Unknown — category not in the wedge corpus                                                             | Fail-closed contract              |

## What the reviewer is confirming

- Each expected answer matches the controlling statute/regulation **as of the review date**, including the Colorado rows (cited via law.justia.com because the official C.R.S. portal is not deep-linkable — confirm excerpts against the official C.R.S.).
- Rows with `effective_date: null` (WA milk-license statutes, the two eCFR rows, RCW 69.22.010): confirm or fill the current amendment's effective date.
- Known pending change: Colorado HB26-1033 ("Tamale Act") effective 2027-01-01 — the CO cottage_food rows need re-encoding when it lands.
- The fail-closed behaviors (cases 13–15) are correct _product_ behavior: asking or declining is the right answer there, not a gap.

## Live model drift eval (scheduled complement to CI)

The CI harness above never calls the model — it proves the deterministic floor only. Whether the real model's supplementary body passes citation-binding and contradiction validation (or silently falls back to the template every time) is checked by the gated live eval in `utils/regulations/live-explain-eval.ts` (`__tests__/utils/regulations/live-explain-eval.test.ts`).

**Cadence: run it on every corpus change, `ASSISTANT_MODEL` bump, or explain prompt change** (also reasonable before each attorney re-review), via:

```bash
pnpm run test:live-eval   # = RUN_LIVE_EVAL=1 jest __tests__/utils/regulations/live-explain-eval.test.ts --runInBand
```

It reports the template-fallback rate, every validation-failure reason, and the decision-contradiction count. It hard-fails on any decision contradiction or a 100% fallback rate — both mean the model path drifted even though every served answer stayed safe. It spends tokens and needs Anthropic credentials, so it never runs in the default Jest suite or CI.

## How sign-off is recorded

1. Reviewer confirms or corrects each golden case against the matrices.
2. For each confirmed case, set `review` in `utils/regulations/golden-answers.ts` to `{ status: "approved", reviewer: "<name, firm/org>", reviewedAt: "<YYYY-MM-DD>" }` — the eval test rejects "approved" without a named reviewer and date.
3. Record the engagement in the log below.
4. Corrections land as corpus edits + golden-set updates in the same commit, so CI re-proves every changed answer.

## Reviewer engagement log

| Reviewer | Organization | Date | Scope | Outcome                                                                                                                               |
| -------- | ------------ | ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| —        | —            | —    | —     | **No reviewer engaged yet (2026-11-07). Candidate paths: FTCLDF, a food-law attorney, WA/CO state extension offices. BLOCKS LAUNCH.** |
