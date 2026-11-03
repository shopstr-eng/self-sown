---
name: Metro dev-bundle staleness
description: The long-running Expo/Metro process can miss newly added files (stale Haste map), making every bundle request 500 while the dev client silently runs its old cached bundle.
---

When the iPhone dev client "isn't updating" despite reloads, suspect Metro before the app code:

- The Metro background task (expo start --dev-client --port 8088, behind the cloudflared quick tunnel) can run for days; its Haste module map has missed files added after it started (seen: `terminal-init-signal.ts` unresolvable hours after creation).
- The device never shows the build failure usefully — bundle 500s make the dev client fall back to its last good cached bundle, so the user just sees the OLD bug persisting.
- Diagnose from the container, not the device: `curl "http://localhost:8088/apps/mobile/index.bundle?platform=ios&dev=true&hot=false&lazy=false&minify=false"` — a 500 with `UnableToResolveError` JSON confirms staleness; a 200 lets you grep the bundle for a marker string from the fix to prove the device CAN receive it.
- Fix: ShellKill the Metro task, restart with `--clear` (same env: EXPO_PUBLIC_API_BASE_URL, EXPO_PACKAGER_PROXY_URL set to the tunnel URL). The cloudflared tunnel survives a Metro restart (it forwards 127.0.0.1:8088), so the dev link URL stays the same.

**Why:** cost a full debugging round where a shipped, tested fix appeared broken on device.
**How to apply:** any time the user reports the dev build still shows a bug after a JS-only fix was pushed, verify the served bundle before touching code.
