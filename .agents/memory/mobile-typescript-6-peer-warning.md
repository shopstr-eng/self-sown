---
name: Expo tooling peer-expects TypeScript 5
description: Workspace is unified on typescript 6.0.3; @expo/require-utils still declares a TS ^5 peer (pnpm warning only so far); apps/mobile/tsconfig.json must not set baseUrl under TS 6.
---

The workspace pins a single `typescript@6.0.3` everywhere (root + apps/mobile).
pnpm install reports one unmet peer: `@expo/require-utils` (via expo →
expo-constants → @expo/config) declares `typescript@"^5.0.0"`.

**Why:** aligning on one TS version removed the `*_typescript@5.9.3` /
`*_typescript@6.0.3` peer-variant duplicates from node_modules/.pnpm (expo and
nostr-tools packages were each installed twice). Verified benign:
`expo config` and `expo export --platform web` both run clean under TS 6.0.3
(native prebuild untested). No pnpm override needed.

**How to apply:** treat the peer warning as noise. If expo CLI fails with
`Cannot find module './v3/external.cjs'` from zod, that's a corrupted pnpm
store entry (missing zod v3/ dir), NOT the TS peer — repair via
`rm -rf node_modules/.pnpm/zod@<ver>` + `pnpm install --frozen-lockfile
--ignore-scripts`. Also: apps/mobile/tsconfig.json must NOT set `baseUrl` —
TS 6 errors on it (deprecated, removed in TS 7); `paths` resolves relative
to the tsconfig without it.
