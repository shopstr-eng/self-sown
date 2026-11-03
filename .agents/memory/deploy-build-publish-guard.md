---
name: Deploy-build publish guard
description: scripts/deploy-build.sh refuses to run unless SELF_SOWN_PUBLISH_BUILD=1 is set; the marker is set only by the .replit [deployment] build command.
---

`scripts/deploy-build.sh` begins with a guard that exits 1 unless `SELF_SOWN_PUBLISH_BUILD=1` is set, because its pre/post-build cleanup does `rm -rf` on node_modules, .git, **tests**, $HOME caches, and the temp dir — catastrophic if run by hand in the workspace or on a dev machine.

The marker is set only by the `[deployment]` build command in `.replit` (`build = ["bash", "-c", "SELF_SOWN_PUBLISH_BUILD=1 pnpm run build:deploy"]`).

**Why:** the script is written for the publish sandbox only; nothing else stopped a developer or agent from running it locally and wiping the repo.

**How to apply:** if you change how the deploy build is invoked, keep the marker in lockstep between `.replit` and the guard in `deploy-build.sh`. Scenario F of `scripts/deploy-build.test.sh` pins the guard; scenarios A–E set the marker to simulate the publish environment.

The pre-build cleanup also `rm -rf apps/mobile` BEFORE `next build`, so web code must NEVER import from `apps/mobile/**` — dev/typecheck/jest resolve it fine, but the publish build fails MODULE_NOT_FOUND (bit us 2026-11-03 via `@/apps/mobile/lib/tap-to-pay-marketing-copy` in pages/faq, pages/tap-to-pay, utils/geo/page-content). Shared web+mobile modules belong in `packages/domain` (imported as `@self-sown/domain`), which the filtered prod install keeps.
**Why:** the deploy image is slimmed by deleting the mobile app pre-build; any web→mobile import is invisible until publish.
**How to apply:** when a web file needs code that lives in apps/mobile, move the module to packages/domain (dependency-free) and update importers + source-scan guards that pin the old path.
