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
  list in the mobile suite).
- The FAQ is data-driven: the mark renders only for items flagged
  `applePayMark: true` — flag and render guard are tested as a pair.
- The required Apple Pay service disclaimer text is a separate rule (see
  tap-to-pay-disclaimer-pairing.md); a page can need the mark, the
  disclaimer, or both.
