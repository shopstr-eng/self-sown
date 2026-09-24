---
name: Orphaned service-worker registrations
description: Renaming/removing a service-worker path strands old workers forever; every historical SW path must serve a self-destructing worker, and hard refresh does not bypass a SW.
---

If the app ever served a service worker at a path that now 404s (e.g. next-pwa's default `/sw.js`, later moved to `/service-worker.js`), browsers holding that registration can never update — a 404 update check keeps the old worker active forever. If that old worker cache-firsted HTML navigations, the user is pinned to stale HTML whose chunks no longer exist, so hydration dies and every HeroUI image (logo/avatars/product/YouTube thumbnails) stays invisible.

**Why:** A hard refresh does not unregister or replace a stale service worker — when the worker's update check 404s, the old worker stays active, so the user can republish and hard-refresh yet still see the broken old page. Diagnosed after a user reported all deferred-load images missing on the live site while fresh-visitor screenshots rendered fine.

**How to apply:**

- Never let a historical SW path 404. Keep a self-destructing worker at every path a SW was ever registered from: skipWaiting → delete all caches → `registration.unregister()` → navigate open window clients once. No fetch handler (requests fall through to network). See `public/sw.js`.
- The kill-switch at `public/service-worker.js` (v2, NetworkOnly) handles the current path; `proxy.ts` CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES must list every SW path so custom domains serve them too.
- Symptom signature: SSR text renders, ALL client-loaded images invisible, persists across hard refresh and republish, fresh/incognito loads fine.
