---
name: Audit overrides that can't be bumped
description: Two audit advisories resist the usual pnpm.overrides pin fix — decode-uri-component (ESM-only patch breaks CJS caller) and image-size (no patched release)
---

Most `pnpm audit` findings in this repo are fixed by bumping pins in BOTH overrides blocks in package.json (pnpm.overrides and the legacy npm overrides block — keep them in sync). Two do not yield to that:

- `decode-uri-component`: the only patched release (0.5.0) is ESM-only, and its consumer chain `@react-navigation/core > query-string@7` loads it with CommonJS `require()`. Pinning 0.5.0 makes `query-string.parse` throw `TypeError: decodeComponent is not a function` — a mobile deep-linking regression that jsdom tests don't catch. Verify with a real CJS smoke test before accepting the override.
- `image-size` (via apps/mobile > expo > metro): advisory lists patched versions as `<0.0.0` — no fix exists; only a future metro release clears it.

**Why:** overriding to silence an advisory can trade a theoretical CVE for a real runtime break; the caller's module system and semver range bound what a pin may force.

**How to apply:** when a future audit re-flags these two, don't re-attempt the pins — check whether query-string/react-navigation or metro have shipped compatible releases first.
