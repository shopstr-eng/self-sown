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

- Each expected answer matches the controlling statute/regulation **as of the review date**, including the Colorado rows (cited via law.justia.com because the official C.R.S. portal is not deep-linkable — see "Pre-review verification" below for what has already been cross-checked).
- The fail-closed behaviors (cases 13–15) are correct _product_ behavior: asking or declining is the right answer there, not a gap.

## Pre-review verification (2026-11-07)

The flagged preparation items were resolved against official sources ahead of engaging a reviewer, so the reviewer's effort goes to legal judgment rather than citation archaeology:

- **C.R.S. excerpts vs law.justia.com** — every Colorado excerpt re-checked verbatim against justia's 2025 C.R.S. text; the § 25-4-1614 excerpts (eligible foods, course, cap, labeling, delivery, resale) additionally cross-checked against the _official_ session-law rendering in HB26-1033 (ch. 375, Session Laws of Colorado 2026), which restates the amended subsections. All matched. Corpus effective dates confirmed against justia's source-history lines (§ 25-4-1614 → SB 16-058 effective 2016-05-04; § 25-5.5-117 → added effective 2005-04-22; § 35-21-105 → SB 21-266 effective 2021-07-02; § 35-21-104 → SB 09-127 effective 2009-07-01). **Remaining for the reviewer:** a spot-check of §§ 25-5.5-117 and 35-21-104/-105 against the official LexisNexis C.R.S. portal, which is not deep-linkable for automated verification.
- **`effective_date: null` rows — filled from official sources:** RCW 15.36.051 → `2015-10-09` (ESHB 2128, 2015 3rd sp.s. c 27, enrolled session law at lawfilesext.leg.wa.gov); RCW 69.22.010 → `2015-07-24` (HB 1622, 2015 c 203, enrolled session law); 21 CFR 1240.61 → `1987-09-09` (final rule "Requirements Affecting Raw Milk for Human Consumption in Interstate Commerce", Docket 81N-204C, 52 FR 29509, effective date stated in the document); 21 CFR 118.1 → `2009-09-08` (74 FR 33030, per the federalregister.gov document record; the 2010-07-09 date often cited is the _compliance_ date for producers with 3,000+ hens, not the rule's effective date). The two WSDA agency-guidance rows (Retail Raw Milk guide, Truth About Raw Milk Sales) keep `effective_date: null` because guidance documents carry no statutory effective date — the reviewer should confirm the guidance is still current WSDA policy.
- **CO HB26-1033 ("Tamale Act") — confirmed:** chapter 375, Session Laws of Colorado 2026, approved 2026-06-04. Per its Section 8, the act took effect upon passage **except** the § 25-4-1614 and § 35-36-102 amendments, which take effect **2027-01-01**. The current corpus encoding remains correct until then. When it lands, the CO cottage_food rows must be re-encoded — including the cap flipping from **net** to **gross** revenue and the new time/temperature-control-for-safety food category (tamales, burritos, tortas). Tracked in docs/regulations-wedge-decision.md.

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

## Outreach draft (ready to send)

Candidate paths, in rough order of fit: the **Farm-to-Consumer Legal Defense Fund** (farmtoconsumer.org — cottage food, raw milk, and herd-share law is their core docket; they have done state regulatory reviews for members), a **food-law attorney** licensed in WA or CO, or the **WSU / CSU Extension** cottage-food program contacts (CSU Extension literally wrote the CO course the statute references).

> Subject: Paid review request — 15-question food-regulation answer set (WA + CO cottage food, raw milk, eggs)
>
> Hello,
>
> We run a marketplace for local food producers and are about to launch a tool that answers seller questions like "Can I sell jam at a farmers market in Washington?" from a fixed, statute-cited rule set (RCW 69.22, RCW 15.36/69.25, C.R.S. §§ 25-4-1614, 25-5.5-117, 35-21-104/-105, 21 CFR 1240.61/118.1). Before launch we need a qualified reviewer to confirm the answers against the controlling law.
>
> The review packet is deliberately small: 15 pinned question/answer pairs with verbatim statute excerpts, citations, and effective dates already verified against the enrolled session laws and the Federal Register. We are asking for a confirm-or-correct pass on each answer, plus a named sign-off we can record per case. We are happy to pay for the review as a scoped engagement.
>
> Can we send you the packet?

When a reviewer responds, record the engagement in the log above and work cases per "How sign-off is recorded."
