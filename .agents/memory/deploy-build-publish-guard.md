---
name: Deploy-build publish guard
description: scripts/deploy-build.sh refuses to run unless SELF_SOWN_PUBLISH_BUILD=1 is set; the marker is set only by the .replit [deployment] build command.
---

`scripts/deploy-build.sh` begins with a guard that exits 1 unless `SELF_SOWN_PUBLISH_BUILD=1` is set, because its pre/post-build cleanup does `rm -rf` on node_modules, .git, __tests__, $HOME caches, and the temp dir — catastrophic if run by hand in the workspace or on a dev machine.

The marker is set only by the `[deployment]` build command in `.replit` (`build = ["bash", "-c", "SELF_SOWN_PUBLISH_BUILD=1 pnpm run build:deploy"]`).

**Why:** the script is written for the publish sandbox only; nothing else stopped a developer or agent from running it locally and wiping the repo.

**How to apply:** if you change how the deploy build is invoked, keep the marker in lockstep between `.replit` and the guard in `deploy-build.sh`. Scenario F of `scripts/deploy-build.test.sh` pins the guard; scenarios A–E set the marker to simulate the publish environment.
