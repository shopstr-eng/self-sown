---
name: Tailwind v4 dead vs deprecated utilities
description: Which v3-era utility families Tailwind v4.3.3 silently drops vs still generates (verified by compile probe) — don't mass-migrate the ones that still work.
---

Verified against tailwindcss 4.3.3 via `compile()` + `build(candidates)` probe (theme-less probe is enough for static utilities; theme-dependent classes like `bg-black/20` show as dropped without `@import "tailwindcss"`, so interpret carefully). The probe is now a permanent Jest test at `__tests__/styles/tailwind-compile-probe.test.ts` — update its expected declarations when intentionally adopting a Tailwind upgrade's new sizes.

- **Silently dropped (no CSS, no error):** `*-opacity-*` (`bg-opacity-20`, `hover:bg-opacity-80`, …). Guarded now by scripts/check-theme-colors.mjs; v4 form is the slash modifier (`bg-black/20`).
- **Deprecated aliases — MIGRATED + guarded (Sept 2026):** `flex-shrink-*`/`flex-grow-*` → `shrink-*`/`grow-*`, `overflow-ellipsis` → `text-ellipsis`, `decoration-slice`/`decoration-clone` → `box-decoration-*`, `bg-gradient-to-*` → `bg-linear-to-*`. Probe-verified: all identical CSS except `bg-linear-to-*`, which ADDS a no-oklab `@supports` fallback (equal in modern browsers, better in old ones — safe). check-theme-colors.mjs flags these aliases so they don't creep back before a Tailwind major drops the shims. Note: the compile probe normalizes class names via replaceAll, which also rewrites the `flex-shrink`/`flex-grow` CSS PROPERTY inside declarations — compare rule bodies, not raw bytes. `ring` is the one remaining un-migrated alias (deliberate, still fine).
- **Generated but re-scaled vs v3 (meaning changed):** only the `-sm` size tokens — `shadow-sm` (v3 size = v4 `shadow-xs`), `rounded-sm` (= `rounded-xs`), `blur-sm`/`backdrop-blur-sm` (= `blur-xs`/`backdrop-blur-xs`) — plus `outline-none` (v3 behavior = v4 `outline-hidden`; v4 `outline-none` removes the outline entirely, incl. forced-colors). All pinned to their v3 sizes codebase-wide and guarded by scripts/check-theme-colors.mjs.
- **Bare aliases UNCHANGED (accept, don't migrate):** bare `shadow`/`rounded`/`blur` are v4 aliases to the `-sm` sizes, whose v4 defaults equal the v3 defaults — verified by compile probe with the real theme (no project overrides of `--radius-*`/`--shadow-*`/`--blur-*`).

**Why:** mass-renaming working aliases would churn hundreds of call sites for zero behavior change; only the dropped and re-scaled families are real bugs.

**How to apply:** before "fixing" any v3-looking class, probe whether the installed Tailwind version generates it; reserve edits for dropped or re-scaled utilities.
