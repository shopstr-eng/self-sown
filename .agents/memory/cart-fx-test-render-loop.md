---
name: Identity-unstable prop defaults cause effect render loops
description: Destructuring defaults `= {}` on optional object props mint new identities per render; when those props sit in effect deps, tests omitting them hit a "Maximum update depth exceeded" loop. Use a frozen module-level empty object.
---

Optional object props destructured with `= {}` defaults (e.g. `appliedDiscounts = {}`) create a NEW object identity on every render. If any such prop appears in a `useEffect` dependency array whose body sets state unconditionally (e.g. `setNativeShippingPerSeller({})` with no bail-out), the component enters an infinite render loop — in jest this surfaces as a 50k+-line `Maximum update depth exceeded` log and an exit -1 with no tail output.

**Why:** The cart-invoice-card fx suites failed exactly this way (2026-07-09). The real app page passed stable state objects for every optional prop, so the loop ONLY reproduced in tests that omitted them — it looked like a pre-existing test-environment mystery until the identity churn was traced.

**How to apply:**

- Use a shared `const STABLE_EMPTY_OBJECT = Object.freeze({})` at module level as the destructuring default for every optional object prop that participates in effect deps (cart-invoice-card does this now — follow the pattern for new props).
- If an fx/cart suite dies with exit -1 and a giant update-depth log, suspect a newly added `= {}`/`= []` default or a new unconditional setState in an effect, and check which props the failing test omits.
- Shell note: a killed bash mid-file-swap leaves the swapped copy in the tree — back up the edited file to /tmp first and verify restoration by grepping a symbol unique to your version.
