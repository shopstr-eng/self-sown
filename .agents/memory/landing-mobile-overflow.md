---
name: Landing page mobile "overflow" is content clipping, not page scroll
description: Why horizontal-overflow complaints on the marketing landing page are really fixed-width elements being clipped, and the containment pattern to fix them
---

# Diagnosis first: the page can't scroll horizontally

`styles/globals.css` sets `html { overflow: hidden }` and `body { overflow-x: hidden; overflow-y: auto }`, and the landing root is also `overflow-x-hidden`. So a true horizontal scrollbar is impossible. When someone reports the landing page "overflows" on mobile, it means a fixed-width element is **wider than the viewport and getting clipped/cut off**, not that the page scrolls.

**How to apply:** don't chase a phantom scrollbar. Find fixed-width descendants (`w-80`, `min-w-[...]`, `max-w-[NNvw]`) that exceed a small phone width and make them responsive. A `console.log` overflow probe is useless here for two reasons: the workspace console pipe only captures `console.error`/unhandledrejection, and the app_preview screenshot always renders at desktop width so mobile-only clipping never reproduces.

# Containment pattern (copy the storefront social section)

`components/storefront/sections/section-social-posts.tsx` is the reference. Robust horizontal carousel/track containment:

- wrapper: `w-full min-w-0 max-w-full overflow-hidden` (NOT `max-w-[84vw]` — vw ignores the parent and the scrollbar)
- each card: cap to the viewport, e.g. `w-[min(20rem,calc(100vw-2.5rem))]`, so a single card always fits with margin on the smallest phone
- give the centering ancestor `w-full min-w-0` too, so flex children can actually shrink

**Why:** a fixed `w-80` (320px) card inside a `max-w-[84vw]` wrapper is wider than the visible carousel on a ~360px phone, so it's clipped and looks like overflow. The `min(...,calc(100vw-…))` cap is what makes it truly fit.

# Second pass: it's fit/cramping, not a scrollbar

A true horizontal PAGE scroll is impossible here (html overflow:hidden, body + root overflow-x-hidden). When the user still reports "overflow" after that, they mean elements look cramped/clipped at mobile fit, not a real scrollbar. Audit confirmed the ONLY element wider than a phone is the comparison table (`min-w-[640px]`), safely inside `overflow-x-auto` (scrolls within its own card — acceptable). Fixes that actually helped: hide the nav brand text below `sm` (logo only) with `hidden sm:inline-block`; make CTA button rows full-width stacking on mobile (`w-full sm:w-auto` on Link + button, container `flex w-full max-w-md flex-col sm:max-w-none sm:flex-row`); `break-words` on big headlines. Avoid `100vw` in card widths (it includes the scrollbar and over-sizes) — prefer `w-64 sm:w-80`.

**Why:** chasing a phantom page-scrollbar wastes rounds; the leverage is responsive fit (stacking, hiding, wrapping) plus keeping the one genuinely-wide block (the table) inside an overflow-x-auto scroller.

# Correction: the comparison table WAS the perceived overflow

Earlier I called the `min-w-[640px]` table "acceptable" because it sat in `overflow-x-auto`. The user disagreed — on a phone a 640px scroll region inside the page reads as the page overflowing. Real fix: move the floor to `sm:min-w-[640px]` (no hard min-width below 640px so the table fills 100% and wraps), and scale down on mobile (padding p-2, text-xs, check-marks text-base, `align-top` on cells). Keep the roomy sizing from `sm` up.

**Why:** "it scrolls inside its own card" is not the same as "it fits"; for a comparison table the leverage is letting it reflow/shrink on mobile, not wrapping a fixed-width table in a scroller.

# ACTUAL root cause (measured): flexbox min-width:auto on the global <main>

After several wrong guesses, a headless-chromium measurement at 375px (playwright-core pointed at $REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE) found the real culprit. `_app.tsx` wraps every page in `<div class="flex"><main class="flex-1">`. A flex item defaults to `min-width:auto`, so <main> would NOT shrink below its content's intrinsic width and stayed 1280px (=max-w-7xl/80rem) wide on a 375px viewport — that was the page-wide horizontal overflow. The landing page's own root div had `overflow-x-hidden`, but that's useless because the too-wide element was its PARENT (<main>), not a descendant. Fix: add `min-w-0` to the flex child (`<main className="min-w-0 flex-1">`, and `w-full min-w-0` on the `flex` wrapper). Verified: body.scrollWidth 1280 -> 375, zero offenders.

**Why:** `overflow-x:hidden` on body/root only clips DESCENDANTS; it cannot constrain an ancestor flex item that won't shrink. The canonical mobile-overflow bug is a `flex-1`/flex child missing `min-w-0`. Always MEASURE (headless browser at 375px, compare body.scrollWidth to innerWidth, walk ancestors for the first non-clipping wide element) instead of eyeballing — desktop screenshots render ~1280px and hide it entirely.
