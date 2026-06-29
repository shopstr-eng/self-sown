---
name: Machine-readable marketing/tier/FAQ surfaces
description: Which agent/LLM-facing files enumerate membership tiers/pricing AND where FAQ/fee marketing CLAIMS are duplicated across JSON-LD (edit all on a claim/pricing change) vs pure-discovery files that must NOT.
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

# FAQ / fee CLAIMS (not just pricing) are duplicated across JSON-LD

A marketing/FAQ _claim_ (e.g. the "no mandatory fees" / fee-structure
clarification) is hardcoded in MULTIPLE served structured-data blocks, plus
the rich-content surfaces above. When a claim changes, grep the claim string
and update all of:

- `components/structured-data.tsx` — homepage FAQPage JSON-LD. Its short
  Organization/WebSite descriptions keep accurate face-value taglines like
  "zero platform fees"; do NOT bloat those with the long caveat.
- `pages/faq/index.tsx` — `faqSections` feeds BOTH the visible /faq accordion
  AND the /faq FAQPage JSON-LD from one source (edit once, both update).
- `pages/producer-guide/index.tsx` — HowTo JSON-LD `step[]` text.
- `utils/geo/page-content.ts` + `public/llms-full.txt` — agent/LLM copy.

**Gotcha:** the homepage FAQ has TWO separate copies — the JSON-LD in
`structured-data.tsx` and the visible `FAQItem` answer prop in
`pages/index.tsx`. They are NOT generated from one source, so a claim edit
must touch both or they drift. The homepage `FAQItem` also lazy-renders its
answer via `{isOpen && ...}`, so the visible answer is absent from initial
SSR HTML — only the JSON-LD answer is crawler-visible.

**Why:** a single architect pass first missed the /faq + /producer-guide
JSON-LD and the homepage JSON-LD↔visible drift; only grepping the claim
string across pages/ + components/ finds them all.

**Guards (all keyed off `utils/geo/fee-claims.ts`):**
`structured-data-claim-sync.test.ts` pins claims PRESENT across the JSON-LD
copies; `discovery-files-no-claims.test.ts` pins them ABSENT from pure-discovery
files; `rich-content-fee-claims.test.ts` pins them PRESENT in the rich-content
files agents read — `llms-full.txt` carries "no platform fee"+"no fees at all",
`page-content.ts` carries "no mandatory platform fees"+"Zero Platform Fees".
Neither rich-content file uses "never adds a fee", so map claims to the surface
that genuinely carries each phrasing or you get false failures.

Human-prose pages (`pages/about`, `pages/terms`) and the self-host "no
platform fees" HowTo step are accurate face-value claims, not structured-data
marketing — leave them unless the task is about those pages.
