# Major Dependency Upgrade Decisions

Durable record of deliberate decisions on upstream (Shopstr) major-version
dependency upgrades. Add a dated entry whenever a major bump is evaluated and
adopted or deferred, so future upstream syncs don't re-litigate settled calls.

## 2026-09-02 — Dependabot major-updates batch

Upstream's Dependabot major-updates branch carried five majors, merged
upstream without behavioral validation. Each was evaluated against its
changelog:

### Adopted

- **`framer-motion` 12 → 13**: v13's only React breaking change removes
  `@emotion/is-prop-valid` as an optional dependency in favor of explicit
  `MotionConfig isValidProp` injection; it affects only styled-components /
  Emotion users. Milk Market uses neither — usage is plain `motion.*`,
  `AnimatePresence`, and `useReducedMotion` (`components/framer.tsx`,
  `components/utility-components/file-uploader.tsx`,
  `components/storefront/storefront-email-popup.tsx`,
  `components/free-shipping-notification.tsx`).
- **`@getalby/lightning-tools` 8 → 9**: v9's only breaking change reworks
  units in the 402/L402 fetch _client_ response. Milk Market never uses that
  client API (its L402 support is a self-built server in `utils/l402/` +
  `pages/api/mcp/create-order.ts`); local usage is `LightningAddress`,
  `Invoice`, `getSatoshiValue`, `getFiatValue` only.
- **`@testing-library/jest-dom` 6 → 7**: v7 requires `@testing-library/dom`
  as a peer (already a direct devDependency) and Node ≥ 22 (runtime is Node
  22; `engines` is `>=22.4.0`). No matcher renames/removals; the import in
  `jest.setup.js` is unchanged.

Validated with focused Jest suites for each consumer, full `tsc --noEmit`,
serial full-Jest shards, and a Next 16.2.11 production build.

### Deferred (with revisit triggers)

- **`@heroui/react` 2 → 3 — DEFERRED.** v3 is a ground-up rewrite on React
  Aria Components: `HeroUIProvider` is removed, component hooks
  (`useDisclosure`, etc.) are removed/replaced, the `heroui()` Tailwind
  plugin — through which the entire neo-brutalist theme is defined — is
  removed, collection components move from `key` to `id`/`textValue`
  identity, and Framer Motion is dropped as a dependency. Every component in
  the app would need migration; this is a dedicated project, not a dependency
  bump. **Revisit when:** a planned migration effort is scheduled (HeroUI's
  incremental/coexistence migration guide is the starting point), or HeroUI
  v2 stops receiving security fixes.
- **`typescript` 6 → 7 — DEFERRED.** TypeScript 7.0 is the Go-native compiler
  (~10x faster) but ships **no compiler API** (a new API lands in 7.1).
  `typescript-eslint` (used by `eslint.config.mjs`) and any other programmatic
  consumer still require TypeScript 6 side-by-side, so a 7.0 install would
  silently break lint. **Revisit when:** TypeScript 7.1 ships the new API AND
  a `typescript-eslint` release declares TypeScript 7 support.
