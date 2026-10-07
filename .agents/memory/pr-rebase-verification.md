---
name: PR rebase verification scope
description: after a conflict-heavy PR rebase, run the FULL workspace typecheck before pushing — staged-file hooks and mobile-only tsc miss cross-package breaks.
---

When rebasing a stacked PR with conflicts (e.g. Phase 5/6 mobile PRs), the cherry-pick/amend pre-commit hook only lint-checks staged files, and `apps/mobile` tsc only covers the mobile package. Conflict resolutions that rename imports or drop exports break `pages/` and `utils/` silently — the break surfaces only at the next full `tsc` / `next build` on main.

**Why:** PR #34 rebase (Oct 2026): a `@milk-market/domain` sweep covered apps/scripts/tests but missed `pages/api/shipping/return-label.ts`, and a conflict "take-ours" dropped an export the PR's runtime.ts needed. Merged main failed to build; needed a follow-up fix commit.

**How to apply:** (1) brand/package-rename sweeps must grep repo-wide (`pages utils apps packages __tests__ scripts`), never just the mobile dir; (2) before pushing a rebased PR branch, restart the `typecheck` workflow and confirm green — do not rely on the pre-commit hook; (3) when resolving "ours vs theirs" on a shared file like db-service.ts, grep the PR branch for symbols it expects from that file (`git show branch:file | grep ...`) before taking either side.
