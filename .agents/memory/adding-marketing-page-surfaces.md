---
name: Adding a marketing/footer page
description: Full checklist of surfaces a new top-level marketing/info page must be registered in — missing one fails silently
---

Adding a top-level marketing/info page (like /about, /faq, /manifesto) touches all of these; each fails silently if skipped:

1. `pages/<slug>/index.tsx` — the page itself (grid-pattern bg, back button, centered h1, neo-brutalist cards, per /terms).
2. `pages/index.tsx` — homepage footer link list.
3. `pages/_app.tsx` — TopNav exclusion list (~line 1691); marketing pages render with NO navbar. `/developers` was missing here for a long time and showed the app navbar.
4. `components/dynamic-meta-head.tsx` — STATIC_PAGE_META (title/description/canonical/OG).
5. `pages/api/sitemap.xml.ts` — static URL list.
6. `proxy.ts` — AGENT_VIEW_PATHS set, or agents/LLM crawlers get HTML instead of markdown/JSON.
7. `utils/geo/page-content.ts` — PAGE_CONTENT entry backing /api/agent-view (404s without it). Long essays get a summary + "authoritative version rendered at" link, per /terms and /privacy precedent — passing long prose through the plain-text stripper mangles paired asterisks (e.g. "f*cked").
8. `utils/self-host/routing.ts` — SELF_HOST_BLOCKED_PAGE_PREFIXES, or single-tenant self-hosts rewrite the platform page to a seller page instead of redirecting home.
9. `public/llms.txt` + `public/llms-full.txt` — link lists.
10. Tests with mirrored path lists that must ALL be updated in lockstep: `__tests__/utils/geo/marketing-page-negotiation.test.ts` (MARKETING_PATHS + SELLER_PATHS), `__tests__/pages/api/agent-view.test.ts` (MARKETING_PATHS + PAGE_FINGERPRINT), `utils/self-host/__tests__/routing.test.ts` (blocked-pages list).

**Why:** surfaces 6–8 were missed on the first pass of /manifesto and only caught by code review — nothing in the compiler or existing tests flags them (the tests mirror the lists by hand rather than importing them).

**How to apply:** any new top-level info/marketing page, or renaming/removing one. Verify live with `curl -H 'Accept: text/markdown'` — but only after the dev-server rebuild fully finishes (it serves the previous standalone build while compiling, so a too-early curl returns stale HTML and mimics a missing registration).
