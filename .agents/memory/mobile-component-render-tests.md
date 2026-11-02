---
name: Mobile component render tests under root jest
description: Constraints for render-testing apps/mobile components from __tests__/mobile with @testing-library/react-native.
---

Mobile component tests use **@testing-library/react-native v14** (backed by the maintained `test-renderer` package). Do NOT use react-test-renderer — React upstream deprecated it, and it is no longer installed.

Five environment constraints apply when a __tests__/mobile test renders an apps/mobile component:

- The next/jest SWC transform rewrites a component's "@/..." imports using the ROOT tsconfig paths ("@/*" -> "./*"), so they reach jest's resolver as relative specifiers pointing at the repo root, where nothing exists. jest's moduleNameMapper cannot fix this (the specifier is already rewritten). Register virtual mocks keyed on the rewritten root-relative path as seen from the test file (e.g. "../../components/seller-ui" from __tests__/mobile/) — both sides normalize to the same absolute path and match.
- jest.config.cjs maps "^react(/.*)?$" to the root react copy. Without it, apps/mobile's pinned react loads alongside the renderer's react and every hook call crashes (null dispatcher). Re-verified under RNTL v14.
- Mock react-native with host-string stand-ins ({ Modal: "Modal", View: "View", Text: "Text", StyleSheet: { create: identity, flatten: identity } }). StyleSheet.flatten is required: RNTL reads it internally for pointer-events/visibility checks.
- The react-native mock MUST be `{ virtual: true }`: RNTL requires "react-native" internally at module load, and under pnpm that resolves to a peer-context path that a non-virtual mock registered from the test file never matches (real ESM react-native then crashes the suite with "Must use import to load ES Module").
- RNTL must be `require()`d AFTER the jest.mock blocks in the module body (never a static import): the next/jest SWC transform does not hoist jest.mock above static ESM imports. RNTL v14's render/fireEvent are async (`await render(...)`), and its exported `screen` is a placeholder proxy that render() REPLACES — destructure the render() result's queries (or a stored result), never `screen`.

**Why:** these are structural properties of the shared next/jest config, the pnpm monorepo layout, and RNTL v14's API, not one-off bugs; the next mobile component test will hit the same walls.
**How to apply:** copy the mock block and RNTL require pattern from __tests__/mobile/tap-to-pay-education-modal.test.tsx when adding a mobile component test. The `test-renderer` TestInstance type is not importable by name from the root tsc program (nested pnpm dep) — derive it via `Awaited<ReturnType<typeof render>>["container"]`; a hand-written structural type fails tsc because fireEvent requires the real TestInstance (private members make it nominal).
