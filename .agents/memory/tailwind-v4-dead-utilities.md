---
name: Tailwind v4 dead vs deprecated utilities
description: Which v3-era utility families Tailwind v4.3.3 silently drops vs still generates (verified by compile probe) — don't mass-migrate the ones that still work.
---

Verified against tailwindcss 4.3.3 via `compile()` + `build(candidates)` probe (theme-less probe is enough for static utilities; theme-dependent classes like `bg-black/20` show as dropped without `@import "tailwindcss"`, so interpret carefully):

- **Silently dropped (no CSS, no error):** `*-opacity-*` (`bg-opacity-20`, `hover:bg-opacity-80`, …). Guarded now by scripts/check-theme-colors.mjs; v4 form is the slash modifier (`bg-black/20`).
- **Still generated (deprecated aliases, don't "fix"):** `flex-shrink-*`/`flex-grow-*` (= `shrink-*`/`grow-*`), `overflow-ellipsis` (= `text-ellipsis`), `decoration-slice`/`decoration-clone`, `bg-gradient-to-*` (= `bg-linear-to-*`), `ring`.
- **Generated but re-scaled vs v3 (meaning changed):** only the `-sm` size tokens — `shadow-sm` (v3 size = v4 `shadow-xs`), `rounded-sm` (= `rounded-xs`), `blur-sm`/`backdrop-blur-sm` (= `blur-xs`/`backdrop-blur-xs`) — plus `outline-none` (v3 behavior = v4 `outline-hidden`; v4 `outline-none` removes the outline entirely, incl. forced-colors). All pinned to their v3 sizes codebase-wide and guarded by scripts/check-theme-colors.mjs.
- **Bare aliases UNCHANGED (accept, don't migrate):** bare `shadow`/`rounded`/`blur` are v4 aliases to the `-sm` sizes, whose v4 defaults equal the v3 defaults — verified by compile probe with the real theme (no project overrides of `--radius-*`/`--shadow-*`/`--blur-*`).

**Why:** mass-renaming working aliases would churn hundreds of call sites for zero behavior change; only the dropped and re-scaled families are real bugs.

**How to apply:** before "fixing" any v3-looking class, probe whether the installed Tailwind version generates it; reserve edits for dropped or re-scaled utilities.
