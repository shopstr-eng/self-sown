---
name: Brand palette consolidation
description: the app is forced light-only — never add dark: classes or light/dark text pairs; keep darkMode:'class' in the tailwind config even though nothing uses it.
---

The app is light-only by design. Two rules that are not obvious from the code:

1. **Never add `dark:` utility classes or light/dark color pairs.** Dark mode is deliberately disabled; the theme is forced to light.
2. **Keep `darkMode: "class"` in tailwind.config.ts anyway.** HeroUI compiles its own internal dark utilities against that setting; removing it changes the selectors HeroUI generates. It stays inert because the dark class is never applied.

**Why:** the user removed upstream Shopstr light/dark theming during the Self-sown rebrand (2026-09). Only four brand colors exist; use them unconditionally. The `darkMode: boolean` fields on shop profiles are the separate _seller storefront theme_ feature — do not strip them.

**How to apply:** style with the brand colors directly, checking each element's actual surface first (invoice cards and payment countdowns are white-surfaced even where surrounding chrome is dark — blanket text-color mappings there caused invisible text once already).
