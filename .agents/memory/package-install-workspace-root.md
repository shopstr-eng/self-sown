---
name: Workspace-root package installation
description: Package installation callback rejects workspace flags in package tokens.
---

When using the package installation callback for root dependencies in a pnpm workspace, temporarily set `ignore-workspace-root-check=true` in `.npmrc`, then restore it after installation.

**Why:** pnpm rejects a root add without explicit consent, while the installation callback rejects `--workspace-root` as a package token. The temporary setting allows the supported callback to perform the intended root install without changing the project's lasting safety guard.

**How to apply:** use only for intentional root dependency changes; do not move workspace-specific dependencies to the root.

Treat an installation callback's success as a manifest-update result, not proof that every transitive package file is present. If a build reports missing package files, verify the entrypoint on disk and use a frozen-lockfile reinstall to repair the local installation without changing dependency versions.

**Why:** repeated successful callback installs, including a forced one, left a transitive package's compiled entrypoint absent; a local frozen-lockfile repair restored it. Retrying the callback alone did not verify or repair that state.
