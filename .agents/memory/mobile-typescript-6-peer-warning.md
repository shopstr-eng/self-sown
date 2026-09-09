---
name: Expo tooling peer-expects TypeScript 5
description: Workspace is unified on typescript 6.0.3; @expo/require-utils still declares a TS ^5 peer (pnpm warning only so far); apps/mobile/tsconfig.json must not set baseUrl under TS 6.
---

The workspace pins a single `typescript@6.0.3` everywhere (root + apps/mobile).
pnpm install reports one unmet peer: `@expo/require-utils` (via expo →
expo-constants → @expo/config) declares `typescript@"^5.0.0"`.

**Why:** aligning on one TS version removed the `*_typescript@5.9.3` /
`*_typescript@6.0.3` peer-variant duplicates from node_modules/.pnpm (expo and
nostr-tools packages were each installed twice). The peer warning is unverified
for expo CLI flows (export/prebuild) — tracked as a follow-up.

**How to apply:** if mobile build/prebuild tooling fails with type-level errors
inside expo config packages, this peer mismatch is the first suspect. Also:
apps/mobile/tsconfig.json must NOT set `baseUrl` — TS 6 errors on it
(deprecated, removed in TS 7); `paths` resolves relative to the tsconfig
without it.
