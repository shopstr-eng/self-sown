---
name: replit.nix channel caps Node at 18
description: This repl's nixpkgs channel (22.11) only provides up to nodejs-18_x; replit.nix is still evaluated at env-build time, and the real Node 22 runtime comes from .replit modules.
---

# replit.nix channel caps Node at 18

`replit.nix` in this workspace is NOT dead legacy — it is evaluated when the
run environment builds (a bad edit surfaces as an env-build failure, e.g.
during git rebase preparation: "Prepare repository for rebase failed"). The
pinned nixpkgs channel is 22.11, which only provides `nodejs-10_x` …
`nodejs-18_x` — `pkgs.nodejs-22_x` does not evaluate and breaks the whole
environment.

**Why:** Node 22 did not exist when nixpkgs 22.11 was cut. The workspace
actually runs Node 22 via the `nodejs-22` module declared in `.replit`
(`modules = [..., "nodejs-22", ...]`), which uses a different package source.

**How to apply:** never "fix" replit.nix's nodejs-18_x to match .nvmrc — the
channel can't provide it. replit.nix carries a comment explaining this. The
source of truth for the app's Node major is `.nvmrc`, enforced for the
published bundle by the drift guard in scripts/deploy-build.sh. If the
replit.nix redundancy is ever to be removed, first verify the environment
builds without it.
