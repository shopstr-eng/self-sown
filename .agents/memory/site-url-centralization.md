---
name: Site URL centralization gotchas
description: Rules for touching utils/site-url.ts or platform-origin literals — verbatim env semantics, JSX text-child byte identity, and import-time const vs env stubbing in tests.
---

Three non-obvious constraints surfaced by code review when the base domain was centralized into `utils/site-url.ts`:

1. **`getSiteUrl()` must return `NEXT_PUBLIC_BASE_URL` verbatim** (`||` fallback, no trim/slash-strip). Dozens of pre-existing call sites used the raw expression; normalizing changes output for edge-case env values and breaks the pure-refactor contract. Normalization is deliberately deferred (follow-up task exists).
   **Why:** reviewer flagged trim/strip as a behavior change even though default behavior was identical.
   **How to apply:** never "improve" the getter's semantics inside a refactor; do it as its own change with its own tests.

2. **JSX text edits can change SSR bytes without changing visible text.** Splitting `milk.market/stall/` into `{SITE_HOST}/stall/` adds an 8-byte React text-separator comment; merging children into one template literal can remove one. For byte-identical SSR, keep the same number/position of text vs expression children (e.g. `{`${SITE_HOST}/stall/`}` as a single child, or keep text/expr/text structure).
   **Why:** "zero behavior change" was verified by byte-diffing served HTML; child-boundary changes show up there.
   **How to apply:** when replacing literals inside JSX text, wrap the whole fragment in one template literal or preserve the original child boundaries.

3. **Importing SITE_URL/SITE_HOST into tests that stub `NEXT_PUBLIC_BASE_URL` per-test creates an import-time vs call-time mismatch** — the const is captured at module load (from the shell env), the handler reads the stubbed env later. Tests then fail when the outer env differs (e.g. CI without the var).
   **Why:** reproduced by running Jest with a different initial `NEXT_PUBLIC_BASE_URL`.
   **How to apply:** in tests that stub the env var, assert literal expected values matching the fixture; only import SITE_URL in tests that never touch the env var.
