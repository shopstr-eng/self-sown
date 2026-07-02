---
name: Replit AI blueprints scaffold Express/Drizzle that breaks this repo
description: Why the standard Replit AI-integration blueprints don't drop cleanly into this Next.js pages-router app, how to wire the LLM (Anthropic/Claude) minimally, and the Vertex-proxy prefill gotcha.
---

# Replit AI-integration blueprints scaffold Express/Drizzle boilerplate — breaks the build here

This app is **Next.js pages-router + pnpm + raw `pg`** (no Express, no Drizzle).
The Replit AI-integration blueprints (`javascript_anthropic_ai_integrations`,
`javascript_openai_ai_integrations`, and siblings) scaffold server files under
`replit_integrations/`, `server/replit_integrations/`, `shared/models/` and a
staging dir `.replit_integration_files/` that import `express`, `drizzle-orm`,
`drizzle-zod` (+ batch helpers `p-limit`/`p-retry`) and expect
`registerChatRoutes(app)` + `npm run db:push`.

**Why that breaks us:** root `tsconfig.json` has a broad
`include: ["**/*.ts","**/*.tsx"]` with only a small exclude list, so ANY new
`.ts` the blueprint drops is compiled by `tsc --noEmit` and `next build`. With no
express/drizzle installed, that's an instant build break.

**How to wire the LLM here instead (minimal seam):**

- Keep ONE server-only seam (`utils/storefront/llm-json.ts`, `callLLMJson`) that
  does a guarded `await import("@anthropic-ai/sdk")` and a single
  `client.messages.create`. It returns null with no creds so features degrade
  gracefully — no scaffolding needed. `ai-compose.ts` is the sole consumer and
  clamps every model field (hex-only colors, allowlist fonts, capped copy); null
  → deterministic draft.
- Credentials: prefer Replit AI Integrations env vars
  `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
  (pass BOTH to `new Anthropic({ apiKey, baseURL })`); fall back to a plain
  `ANTHROPIC_API_KEY`. Set a `timeout` + `maxRetries` so one call can't hang.
- Models: only those on the Replit Anthropic list (e.g. `claude-sonnet-4-6`).
  Anthropic uses `max_tokens` (>=8192), not `max_completion_tokens`.

**GOTCHA — Vertex-backed proxy rejects assistant-message prefill.** Replit's
Anthropic integration is served through Vertex (`request_id` starts `req_vrtx_`).
Ending the request with an `assistant` `"{"` prefill (the usual trick to force
JSON) returns **HTTP 400 "This model does not support assistant message prefill.
The conversation must end with a user message."** The Messages API also has no
`json_object` response mode. So: end with the USER message, put "return ONLY
JSON, no prose" in the SYSTEM prompt, and parse tolerantly — `JSON.parse` the raw
text, else slice from the first `{` to the last `}` (Claude often wraps output in

```json fences; the slice strips them). Verified live 2026-07-02.

**Install-then-clean:** to get the AI-Integrations env vars you still install the
blueprint (proposeIntegration). Immediately delete the scaffolded
Express/Drizzle files + the `.replit_integration_files/` staging dir afterward
(bash blocks `.replit`-prefixed paths — use code_execution `fs.rm`), and
uninstall the batch/schema extras it re-adds (`p-limit`, `p-retry`, `drizzle-zod`,
`zod-validation-error`). Keep only the SDK package + env vars, or the build stays
red. A plain user-supplied `ANTHROPIC_API_KEY` avoids all scaffolding.
```
