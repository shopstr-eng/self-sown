---
name: Renaming user-visible strings
description: Where to grep before/after changing any user-visible label so colocated tests don't silently break the suite.
---

When renaming/recasing any user-visible string (button labels, headings, toasts), a
grep of only the root `__tests__/` directory is NOT enough. Jest tests are also
colocated next to components under `components/**/__tests__/` (e.g.
`components/settings/__tests__/pro-membership-section.test.tsx`,
`components/utility-components/__tests__/migration-prompt-modal.test.tsx`).

**How to apply:** grep every old string across ALL test dirs with
`rg -F "<old label>" -g '*.test.ts' -g '*.test.tsx'` (no path filter), not just
`__tests__/`. Then judge each hit:

- `getByText("X")` / `getByRole("button",{name:"X"})` with exact match → WILL break, update it.
- `{ exact: false }` matchers → case-insensitive substring, SAFE.
- Non-UI fixtures (e.g. email `subject:` fields) → unrelated, leave alone.

**Why:** an earlier grep that searched only root `__tests__/` missed a colocated
component test asserting exact sentence-case labels, so the full-suite run failed
on strings that looked "clean" in the sweep. The compiler/LSP never catches these —
they are runtime string assertions.

Also: for a same-file duplicate label (a card button AND a modal-confirm button
sharing text, e.g. "Cancel Membership"), tests must scope one via
`within(dialog).getByText(...)` or an unscoped `getByText` throws "multiple
elements" once the modal opens — preserve that scoping when editing the strings.
