---
name: Apple Pay mark parity (web + mobile)
description: Apple's toolkit SVGs are the only allowed Apple Pay artwork; web serves byte-identical copies from public/, and parity tests on both platforms guard fidelity and surface wiring.
---

Any web page that advertises Apple Pay acceptance must render Apple's own
toolkit mark, served byte-for-byte unmodified from
`public/tap-to-pay/logo/` (copies of `apps/mobile/assets/tap-to-pay/logo/`),
via `<img>` with only uniform scaling (pin `width`, `h-auto`, no
`height`, no crop/recolor/overlay).

**Why:** Apple's marketing rules forbid recreated or altered artwork; a
hand-"optimized" web copy is a compliance violation.

**How to apply:**
- Never edit the SVGs under `public/tap-to-pay/logo/`; re-copy from the
  mobile assets dir if the toolkit updates. Two drift guards fail on any
  edit: `__tests__/mobile/apple-pay-marks.test.tsx` and
  `__tests__/pages/apple-pay-marks.test.ts` (the latter also fails if extra
  unverified files appear in the served directory).
- When adding a page that names Apple Pay as an accepted payment, render the
  mark and add the page to the surface-wiring list in
  `__tests__/pages/apple-pay-marks.test.ts` (mobile surfaces have their own
  list in the mobile suite). A discovery scan in that file backstops the
  hand-maintained list: it walks pages/ + components/, strips comments via
  TypeScript's transpileModule (removeComments), and fails when surviving
  copy names Apple Pay without the file serving a `/tap-to-pay/logo/` SVG,
  using the shared component, or holding an entry in its
  REVIEWED_MARK_EXCEPTIONS registry (justified, honesty-tested).
- Buyer-facing payment-option/receipt surfaces (invoice cards, order
  confirmation, order summary, orders dashboard) must render the mark via the
  shared `PaymentOptionLabel`/`ApplePayMark` in
  `components/utility-components/apple-pay-mark.tsx` — never hand-rolled
  `<img>` copies; `isApplePayLabel` there is the one handle detector.
- Order confirmation EMAILS are still text-only: the toolkit ships SVGs,
  which most email clients won't render — revisit if a raster variant is ever
  added.
- The FAQ is data-driven: the mark renders only for items flagged
  `applePayMark: true` — flag and render guard are tested as a pair.
- The required Apple Pay service disclaimer text is a separate rule (see
  tap-to-pay-disclaimer-pairing.md); a page can need the mark, the
  disclaimer, or both.
- The service-notice guard in `__tests__/pages/apple-pay-marks.test.ts`
  scans pages/ + components/ + utils/messages/ and allows only noticed
  pages or entries in its EXEMPT_NON_MARKETING registry (nominative UI:
  settings labels, wallet buttons, receipts, short-form meta copy). New
  "Apple Pay" mentions must either render APPLE_PAY_SERVICE_DISCLAIMER or
  add a justified registry entry; the registry fails if an entry stops
  naming Apple Pay, so it can't rot silently.
- Agent-readable surfaces count as advertising placements too: the same
  suite fails when any PAGE_CONTENT entry (utils/geo/page-content.ts)
  names Apple Pay without the notice in its served text, and pins
  public/llms.txt + public/llms-full.txt to carry the notice verbatim
  (compared against the module constant, never retyped) whenever they
  name Apple Pay. Static .txt files can't import the constant, so the
  verbatim comparison is their drift guard.
