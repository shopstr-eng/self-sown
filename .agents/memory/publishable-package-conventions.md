---
name: Publishable npm package conventions (this monorepo)
description: Constraints for packages/* meant to publish to npm (bins, tsc emit, jest interplay, tarball hygiene) — learned building packages/cli.
---

# Publishable npm package conventions

For a `packages/*` package that will actually publish (unlike the private
src-entry `@self-sown/*` libs):

- **Single-module logic + committed bin shim.** Put all logic in one
  `src/cli.ts`-style module exporting `main(argv, io)`; `bin/*.js` is a
  hand-written ESM shim importing `../dist/*.js`. Reasons: the base tsconfig
  uses `moduleResolution: "Bundler"` (extensionless relative imports that
  Node ESM cannot resolve from dist), and `import.meta.url` entry guards
  break under next/jest's CJS transform. A single module has no relative
  imports to resolve, so Bundler-mode emit runs fine under Node.
- **Bins must `process.exitCode = await main(...)`, never
  `process.exit(await ...)`** — process.exit truncates buffered stdout;
  a large piped JSON response gets cut off (architect reproduced).
- **Pin `files` exactly** (`bin`, `dist/cli.js`, `dist/cli.d.ts`, README,
  LICENSE): tsc emits `src/**/__tests__` into dist too, and a bare
  `"dist"` ships test code.
- **Copy the root LICENSE in `prepack`** (`pnpm run build && cp ../../LICENSE
LICENSE`) and gitignore the copy — npm only packs the package dir.
- **New package wiring:** pnpm-workspace already globs `packages/*`, but root
  package.json turbo filter scripts (build:all/lint/typecheck/test:all) list
  packages explicitly — append the new filter or the package silently skips
  CI checks. Run `pnpm install --ignore-scripts` once to register it.
- If the tool stores credentials, **bind a saved key to the origin that
  minted it** and enforce file mode 0600 with chmod after write
  (writeFileSync mode only applies on creation).

- **Publishing from this container:** the default npm registry is Replit's
  package firewall (`package-firewall.replit.internal`, set in the root
  .npmrc) — a token keyed to npmjs is never sent, so publish fails ENEEDAUTH.
  Pin `--registry=https://registry.npmjs.org/` on publish/view/npx, set
  `//registry.npmjs.org/:_authToken` from the stored NPM_TOKEN secret via
  `npm config set`, and delete it from ~/.npmrc afterward.

**Why:** the first CLI draft passed all 16 tests and still failed review on
cross-origin key disclosure, stdout truncation, and bare-flag handling —
none of which typecheck or happy-path tests catch.

**How to apply:** any future publishable package or bin in this repo; copy
packages/cli as the template.
