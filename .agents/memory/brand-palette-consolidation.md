---
name: Brand palette consolidation
description: the app is forced light-only — never add dark: classes or light/dark text pairs; keep darkMode:'class' in the tailwind config even though nothing uses it.
---

The app is light-only by design. Two rules that are not obvious from the code:

1. **Never add `dark:` utility classes or light/dark color pairs.** Dark mode is deliberately disabled; the theme is forced to light.
2. **Keep `darkMode: "class"` in tailwind.config.ts anyway.** HeroUI compiles its own internal dark utilities against that setting; removing it changes the selectors HeroUI generates. It stays inert because the dark class is never applied.

Core brand colors in tailwind.config.ts: `primary-yellow` #FFD23F, `primary-green` #0D4B3E (deep green since 2026-10 — matches the mobile app's brand green for cross-app consistency; the token was `primary-blue` until the user asked to rename it to match the color), `black`, `white`. Do not reintroduce a blue value or rename tokens without the user asking. Since 2026-10 the palette also includes user-requested earth tones shared with the mobile app: `earth-cream` #F4F1E8 (page backgrounds, e.g. all pages/settings/\*) and `earth-sand` #EEE6D6 (subdued surfaces). The mobile app keeps its own earth palette (#F4F1E8 cream, #C96442 terracotta accent, #17231E text) with neo-brutalist geometry (2px black borders, neoShadow, 6px corners, Poppins) — do not "fix" mobile to pure white/black; the earth base is deliberate. The legacy upstream tokens (`dark-bg`, `dark-fg`, `dark-modal`, `light-bg`, `light-fg`, `dark-text`, `light-text`, `accent-dark-text`, `accent-light-text`, `accent-white`) and raw hex `#292f46` were fully removed and must not be reintroduced. Mapping convention used during the cleanup: light surfaces → white, dark page surfaces → black, dark card/modal surfaces → `primary-green` (preserves contrast against black pages), modal backdrops → `bg-black/50`, the old purple accent → `primary-yellow`.

**Why:** the user removed upstream Shopstr light/dark theming during the Self-sown rebrand (2026-09). The `darkMode: boolean` fields on shop profiles are the separate _seller storefront theme_ feature — do not strip them.

**How to apply:** style with the brand colors directly, checking each element's actual surface first (invoice cards and payment countdowns are white-surfaced even where surrounding chrome is dark — blanket text-color mappings there caused invisible text once already). After deleting a token, grep every variant prefix (hover:/placeholder:/divide:/etc.) for dangling references — Tailwind silently skips unknown classes, so a missed one no-ops with no build error (a dead `hover:text-accent-white/10` survived the cleanup this way).
