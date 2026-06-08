---
name: Machine-readable tier/pricing surfaces
description: Which agent/LLM-facing files enumerate membership tiers/pricing (edit on a pricing change) vs pure-discovery files that must NOT.
---

# Where membership tiers/pricing live in machine-readable content

When membership pricing or tier names change (e.g. Pro→Herd rename, adding the
one-time Wrangler lifetime tier), only a small set of agent/LLM-facing surfaces
actually enumerate tiers. Audit these:

- **Enumerate tiers/pricing — edit these:** `utils/geo/page-content.ts`
  (producer-guide + home markdown) and `public/llms-full.txt`. Keep their
  numbers in lockstep with `utils/pro/constants.ts` (monthly/annual cents +
  `WRANGLER_LIFETIME_PRICE_CENTS`).
- **Agent-facing entitlement copy — edit display text only:**
  `MCP_PRO_REQUIRED_MESSAGE` in `utils/mcp/auth.ts`, and the JSON `reason`
  strings in `pages/api/email/flows/{enroll,process}.ts`. These say "Herd".
- **Pure discovery/transport — do NOT add pricing:** `public/llms.txt`,
  `agents.txt`, `skill.md`, `.well-known/{mcp,agent-card,l402}.json`,
  `pages/api/openapi.json.ts`, `pages/api/.well-known/agent.json.ts`,
  `utils/geo/stall-content.ts`. They describe MCP transport, scopes, rate
  limits, A2A skills, and shop products — membership tiers are not applicable.

**Why:** stops you from re-auditing every file and from polluting discovery
docs with pricing that belongs in the rich-content surfaces.

**How to apply:** internal identifiers/comments keep the legacy "Pro" name
(`PRO_*`, `isPro*`, `/api/pro/*`, `isPubkeyProEntitled`); only user/agent-
visible _display_ text becomes "Herd"/"Wrangler".
