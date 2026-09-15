---
name: Mobile dependency security overrides
description: Safe upgrade constraints for image-size under Metro 0.83 and decode-uri-component under query-string 7
---

Most `pnpm audit` findings in this repo are fixed by bumping pins in BOTH overrides blocks in package.json (pnpm.overrides and the legacy npm overrides block — keep them in sync). These mobile transitive dependencies need compatibility handling:

- `decode-uri-component`: 0.5.x is ESM-only, so do not force it beneath `query-string@7`; override the parent to a patched `query-string` release and package-patch its entry point to expose the named exports older consumers expect.
- `image-size`: patched 2.x no longer accepts filename strings. Metro 0.83 passes filenames for ordinary assets, so its installed versions need a package patch that reads the file into a buffer before calling `image-size`.

**Why:** direct leaf overrides made query parsing or image bundling fail even though the audit became clean. Expo export catches the Metro mismatch but does not execute React Navigation's query methods, so the navigation smoke test is also required.

**How to apply:** keep both override blocks synchronized, preserve the query-string and Metro 0.83 package patches, and run a frozen install, navigation smoke test, and Expo export. Remove patches only after all consumers support the new APIs natively.
