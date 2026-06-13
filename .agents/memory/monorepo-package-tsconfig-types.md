---
name: Monorepo package tsconfig @types resolution
description: Why packages/* tsconfigs must list types explicitly, and the BodyInit gap, under TS6 + pnpm
---

Each `packages/*` (`domain`, `api-client`, `nostr`) compiles its own `tsc -p tsconfig.json`
for `lint`/`typecheck`/`build`. Their `include` is `src/**/*.ts`, which also pulls in
`src/__tests__/*.test.ts`, so the package compile must know jest + node globals.

**Rule:** every package tsconfig must set `"types": ["jest", "node"]`.

**Why:** under the installed TypeScript (6.0.3) + pnpm, _automatic_ `@types` inclusion
does NOT happen for these packages — `tsc --traceResolution` shows zero `@types`
scanning even though `@types/jest` and `@types/node` are installed and hoisted at root
`node_modules/@types`. Without explicit `types`, test files fail with TS2593/TS2304
(`describe`/`test`/`expect`/`jest`) and any source using fetch globals fails too. Relying
on auto-inclusion is the trap; an explicit `types` array resolves reliably via the normal
type-reference-directive walk up to root `node_modules/@types`.

**Gotcha:** `@types/node` provides `fetch`, `Headers`, `RequestInit` as globals but NOT
`BodyInit`. Don't annotate with `BodyInit` in these packages (no DOM lib). If a value is
only ever a `JSON.stringify(...)` result, type it `string | undefined` — `string` is
assignable to fetch's `body`, so the `fetch`/`fetchImpl` call still typechecks.

**How to apply:** when adding/merging a new `packages/*` workspace or a test file under
an existing one, copy the `"types": ["jest", "node"]` line; never assume auto-@types.
The full husky pre-commit chain is `pnpm run pre-commit` (eslint/prettier/jest on staged)
→ `pnpm run lint` (eslint web + `turbo run lint` tsc) → `pnpm run format:check`, so a tsc
type error in any package blocks the commit.
