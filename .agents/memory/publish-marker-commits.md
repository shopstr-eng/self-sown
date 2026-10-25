---
name: Publish marker commits on main
description: Replit publishes create an empty "Published your App" commit on main that can land between your staged work and your commit — always re-check git state after a deploy event
---

Publishing the app creates an EMPTY commit on `main` titled "Published your App"
(`Replit-Commit-Author: Deployment`, with a build-id trailer) and pushes it.

**Why:** if a publish lands while you have staged-but-uncommitted work, HEAD moves
under you: your `git commit` still works (the marker is empty, no conflicts), but
push targets, `git status` ahead/behind counts, and any chained `cmd1 && cmd2` logic
that assumed a fixed HEAD silently operate on the wrong commit. Chained shell lines
that mix verification and mutation (e.g. `if ! grep log; then commit; fi`) make it
worse — a failed log lookup inverts into "green" and the commit runs unverified.

**How to apply:** after any deploy notification, run `git status -sb` +
`git log --oneline -3` before committing. Verify checks first, commit second, never
in one shell line. Never rewrite/drop these marker commits once they're on
origin/main — the deployment already references the build-id.
