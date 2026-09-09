---
name: HeroUI theme must be a direct dependency
description: Tailwind v4 @source glob into node_modules silently matches nothing for transitive deps under pnpm's isolated layout; publish builds lost all HeroUI slot classes (input label float, image reveal, focus rings).
---

`styles/globals.css` scans HeroUI's component-class strings via `@source "../node_modules/@heroui/theme/dist/**"`. Under pnpm's isolated node_modules, only DIRECT dependencies get a top-level entry; `@heroui/theme` was a transitive dep of `@heroui/react`, so a fresh `pnpm install` (what `scripts/deploy-build.sh` runs for every publish) never created that directory. The glob silently matched nothing and the published stylesheet lost ~880 of ~1067 HeroUI slot classes. Dev looked fine only because a stale real directory from an old install masked it.

Symptoms on live: every labeled HeroUI input in every modal renders its label stuck on top of the placeholder (the label-float classes like `group-data-[filled-within=true]:scale-85` are gone), and every HeroUI `Image`/`Avatar` stays invisible (the `data-[loaded=true]:opacity-100` reveal rule is gone).

**Why:** `@source` globs fail silently — zero matches is not an error — and pnpm gives no top-level entry for transitive deps. Tailwind 4.3.3's scanner also does not expand package-name wildcards, so a `.pnpm/@heroui+theme@*/...` fallback glob matches 0 files (verified via @tailwindcss/oxide + in-memory PostCSS compile). Do not attempt that workaround.

**How to apply:**
- Keep `@heroui/theme` pinned as a direct dependency in package.json (aligned to the version `@heroui/react` resolves, currently 2.4.26). Any package whose dist is scanned by a Tailwind `@source` glob must be a direct dep.
- Regression guard: `scripts/check-globals-css.mjs` (run by `__tests__/styles/globals-css.test.ts` and by `scripts/deploy-build.sh` before `next build`) fails loudly when (a) HeroUI marker selectors (`group-data-[filled-within=true]:scale-85`, `data-[loaded=true]:opacity-100`) are missing from the compiled CSS, or (b) a package scanned by a `@source` node_modules glob is not a pnpm-managed symlink resolving into `.pnpm` (catches stale real directories masking a transitive-only dep).
- Diagnosing "labels stuck on placeholders" or "all images invisible site-wide on live but fine in dev": compare compiled CSS from the live site vs a local build for HeroUI marker selectors (`filled-within`, `data-[loaded=true]`); a big diff = source-glob miss, not app code.
