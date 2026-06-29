---
name: Per-stall content negotiation surfaces
description: Adding a machine-readable stall/post view means wiring the same negotiation into all three proxy host branches plus the backing endpoint.
---

Per-stall machine-readable content (markdown/JSON/txt/llms for agents) is served
by `pages/api/stall-agent-view.ts`, but the request only reaches it because
`proxy.ts` negotiates the format and rewrites to it. The negotiation logic is
duplicated across **three** independent proxy branches, and a new negotiated
path (e.g. a single blog post at `/blog/<slug>`) must be added to ALL of them or
it silently works on one host shape and not the others:

1. Platform host (`!isCustomDomain`): matches `/stall/<slug>/...` paths.
2. Custom domain (`isCustomDomain`): matches the seller's own root paths
   (`/`, `/blog/<slug>`, ...) — has its own inline `rewriteToStallAgentView`.
3. Self-host (`routeSelfHost`): same root-path shapes — its own inline
   `rewriteToStallAgentView`.

**Why:** the three branches don't share a helper; each builds its own rewrite +
headers. Custom-domain/self-host post paths are `/blog/<slug>` while the platform
path is `/stall/<slug>/blog/<slug>`.

**How to apply:** thread the new param through `x-stall-format` + sibling headers
(e.g. `x-post-slug`) AND the query string (rewrite can drop the dest query, so
headers are the reliable channel; query is a fallback for direct calls). Always
gate on `negotiateAgentFormat` so browsers/social bots keep getting HTML.
Builders for the new view live in `utils/geo/stall-content.ts`; the endpoint
reads the header/query and switches on it before the stall-level switch.

**llms gotcha:** `negotiateAgentFormat` returns only `md|json|txt|null` — it can
NEVER pick `llms` from an Accept header (there is no standard llms media type).
The stall homepage exposes llms via the dedicated `/llms.txt` file path, not via
negotiation. So a negotiated single resource (e.g. `/blog/<slug>`) needs an
explicit deterministic signal to reach llms: `negotiatePostFormat` adds a
`?format=md|json|txt|llms` query override (browsers never send it), and still
returns null for HTML-only bot UAs so link unfurling keeps working.
