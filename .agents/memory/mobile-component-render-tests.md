---
name: Mobile component render tests under root jest
description: Constraints for render-testing apps/mobile components from __tests__/mobile with react-test-renderer.
---

Three environment constraints apply when a __tests__/mobile test renders an apps/mobile component:

- The next/jest SWC transform rewrites a component's "@/..." imports using the ROOT tsconfig paths ("@/*" -> "./*"), so they reach jest's resolver as relative specifiers pointing at the repo root, where nothing exists. jest's moduleNameMapper cannot fix this (the specifier is already rewritten). Register virtual mocks keyed on the rewritten root-relative path as seen from the test file (e.g. "../../components/seller-ui" from __tests__/mobile/) — both sides normalize to the same absolute path and match.
- jest.config.cjs maps "^react(/.*)?$" to the root react copy. Without it, apps/mobile's pinned react loads alongside the renderer's react and every hook call crashes (null dispatcher).
- Mock react-native with host-string stand-ins ({ Modal: "Modal", View: "View", Text: "Text", StyleSheet.create: identity }) and locate nodes via root.findAllByType("Text") etc. react-test-renderer is deprecated and prints a benign console.error per render.

**Why:** these are structural properties of the shared next/jest config and the pnpm monorepo layout, not one-off bugs; the next mobile component test will hit the same three walls.
**How to apply:** copy the mock block from __tests__/mobile/tap-to-pay-education-modal.test.tsx when adding a mobile component test.
