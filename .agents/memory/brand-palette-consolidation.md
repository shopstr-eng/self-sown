---
name: Brand palette consolidation
description: the app is forced light-only — never add dark: classes or light/dark text pairs; keep darkMode:'class' in the tailwind config even though nothing uses it.
---

The app is light-only by design. Two rules that are not obvious from the code:

1. **Never add `dark:` utility classes or light/dark color pairs.** Dark mode is deliberately disabled; the theme is forced to light.
2. **Keep `darkMode: "class"` in tailwind.config.ts anyway.** HeroUI compiles its own internal dark utilities against that setting; removing it changes the selectors HeroUI generates. It stays inert because the dark class is never applied.

Only four brand colors exist in tailwind.config.ts: `primary-yellow` #FFD23F, `primary-blue` #1E293B, `black`, `white`. The legacy upstream tokens (`dark-bg`, `dark-fg`, `dark-modal`, `light-bg`, `light-fg`, `dark-text`, `light-text`, `accent-dark-text`, `accent-light-text`, `accent-white`) and raw hex `#292f46` were fully removed and must not be reintroduced. Mapping convention used during the cleanup: light surfaces → white, dark page surfaces → black, dark card/modal surfaces → `primary-blue` (preserves contrast against black pages), modal backdrops → `bg-black/50`, the old purple accent → `primary-yellow`.

**Why:** the user removed upstream Shopstr light/dark theming during the Self-sown rebrand (2026-09). The `darkMode: boolean` fields on shop profiles are the separate _seller storefront theme_ feature — do not strip them.

**How to apply:** style with the brand colors directly, checking each element's actual surface first (invoice cards and payment countdowns are white-surfaced even where surrounding chrome is dark — blanket text-color mappings there caused invisible text once already). After deleting a token, grep every variant prefix (hover:/placeholder:/divide:/etc.) for dangling references — Tailwind silently skips unknown classes, so a missed one no-ops with no build error (a dead `hover:text-accent-white/10` survived the cleanup this way).
