---
name: Task-merge resets the diff base
description: After a Project Task agent's work is merged, HEAD resets to the merged commit (an ancestor of your own session commits), so your accepted work + inherited reconciliation deltas reappear as "uncommitted" and mislead architect's git diff.
---

# Task-agent merge resets HEAD below your own commits

When a Project Task agent's changes are merged into main, this environment's
`main`/HEAD can be reset to the merged commit (= origin/main). That merged commit
is an ANCESTOR of your own prior accepted session commits, so:

- Your already-committed session work reappears as **uncommitted working-tree
  changes** vs the new HEAD.
- You also inherit small **reconciliation content deltas** you did NOT author
  (e.g. an OG `<title>` tweak, a competitor fee-range edit in page-content), as
  part of how the platform reconstructs the working tree on top of the merge.

**Why:** the platform resets the branch ref to the merged base and preserves your
net working-tree changes on top; it does not re-attach your old commits to HEAD.

**How to apply:**

- Do NOT trust `architect({ includeGitDiff: true })` right after such a merge — it
  diffs vs the new (older) HEAD and will flag your already-accepted prior commits
  and the inherited deltas as "out of scope," producing a false FAIL. Re-review
  with `includeGitDiff: false` and paste the diff isolated against YOUR last
  session commit.
- Isolate your real task diff without touching the git index:
  `git show <yourLastCommit>:<path> > /tmp/base && diff /tmp/base <path>`.
  `git show` is read-only and never takes `index.lock`.
- Do NOT revert the inherited reconciliation deltas. Reverting violates an
  additive-only / "don't overwrite prior seller copy" constraint and may undo
  intentional merge results.
- The main-agent git guard blocks index-refreshing reads like
  `git diff <commit>` and blocks `rm .git/index.lock` as "destructive." Use
  `git show` instead. Leave a stale `.git/index.lock` for the platform checkpoint
  system to reconcile — do NOT spin up a Project Task to remove an env-local lock
  (task agents run in isolated environments and don't share your `.git`).
