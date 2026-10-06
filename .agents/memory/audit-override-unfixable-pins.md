---
name: Mobile dependency security overrides
description: Compatibility constraints and installed-behavior verification for dependency security overrides and patches
---

Most `pnpm audit` findings in this repo are fixed by bumping pins in BOTH overrides blocks in package.json (pnpm.overrides and the legacy npm overrides block — keep them in sync). These mobile transitive dependencies need compatibility handling:

- `decode-uri-component`: 0.5.x is ESM-only, so do not force it beneath `query-string@7`; override the parent to a patched `query-string` release and package-patch its entry point to expose the named exports older consumers expect.
- `image-size`: patched 2.x no longer accepts filename strings. Metro 0.83 passes filenames for ordinary assets, so its installed versions need a package patch that reads the file into a buffer before calling `image-size`.

**Why:** direct leaf overrides made query parsing or image bundling fail even though the audit became clean. Expo export catches the Metro mismatch but does not execute React Navigation's query methods, so the navigation smoke test is also required.

**How to apply:** keep both override blocks synchronized, preserve the query-string and Metro 0.83 package patches, and run a frozen install, navigation smoke test, and Expo export. Remove patches only after all consumers support the new APIs natively.

When no fixed release exists, use reproducible package patches without inventing
versions or hiding advisories. Version-only scanners can still flag patched
packages; state that limitation and verify the exploit behavior directly through
the real consumer's resolution path.

**Why:** locally patched packages retain their upstream version. Also, a patch
hash in the lockfile and installed directory did not guarantee the edits were
present: hand-authored diffs left several installed packages unchanged, while
patches generated with the package manager's patch-commit command applied.

**How to apply:** generate patches through the package manager, run regression
checks on installed files after a frozen install, and never treat lockfile hashes
or successful installs alone as proof of remediation. If package files are
missing, repair with a forced frozen install instead of changing versions.
