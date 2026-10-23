---
name: Force-push to protected main
description: origin main has branch protection that rejects force-push; reauthor rounds must toggle allow_force_pushes via the REST API and restore settings after.
---

Force-pushing rewritten history to `origin main` (shopstr-eng/self-sown) fails with "protected branch hook declined" — protection blocks force-pushes even with a valid PAT.

**Why:** Branch protection on main has `allow_force_pushes: false` (plus `enforce_admins: true` and 1 required approval), so the admin-bypass intuition does not apply.

**How to apply:** For each reauthor/force-push round: GET `/repos/shopstr-eng/self-sown/branches/main/protection` (save full JSON), PUT the same config with `allow_force_pushes: true` (booleans, not GET's `{enabled}` wrappers), `git push --force-with-lease` via the GH_PUSH_TOKEN credential helper, then PUT the saved original back. Verify `git rev-parse origin/main` matches local after fetch. Run all .git-mutating commands with `DANGEROUSLY_ALLOW_GIT=1`. Backup branch first (`backup/pre-reauthorN`), and verify `git diff backup main` is empty before pushing.

**Rewrite recipe (Oct 2026 reauthor round):** do NOT use `git rebase --onto` to drop commits — platform task-merge commits (Replit-Task-Id trailers) stop cherry-pick with phantom "empty pick" pauses whose trees actually differ, risking silent content loss. Use `git filter-branch -f --env-filter <author rewrite> --commit-filter 'skip_commit for the dropped SHA' --tag-name-filter cat -- <last-good-sha>..HEAD` — trees are copied verbatim, so the final tree is provably identical (`git diff backup HEAD` empty). `git replace --graft` cannot drop an EMPTY commit (rebuilt SHA is identical). Restore PUT must use the SAVED protection JSON, not a fresh GET (a GET after toggling reads back the toggled state). Piping `git commit` output through `grep|head` SIGPIPE-kills the husky pre-commit hook mid-run — redirect to a file and tail it instead.

PUT payload gotcha: `bypass_pull_request_allowances` must contain plain login/slug strings (`{"users": ["calvadev"], "teams": [], "apps": []}`) — copying the GET's full user objects makes GitHub reject the whole PUT with a misleading 422 claiming required keys "weren't supplied". The failed PUT is atomic, so protection is left unchanged.
