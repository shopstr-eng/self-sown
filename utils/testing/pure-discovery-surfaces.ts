// Shared list of the "pure discovery/transport" surfaces served to AI agents.
//
// These files describe MCP transport, scopes, rate limits, A2A skills, feeds,
// and shop products. Membership pricing and fee/marketing CLAIMS are NOT
// applicable here — those live only in the rich-content surfaces
// (`public/llms-full.txt`, `utils/geo/page-content.ts`) and the JSON-LD copies
// (homepage / /faq / /producer-guide), kept in sync with
// `utils/pro/constants.ts` / `utils/geo/fee-claims.ts`.
// (See memory: machine-readable-tier-surfaces.md.)
//
// Consumed by discovery-files-no-pricing.test.ts and
// discovery-files-no-claims.test.ts, which assert the canonical price and
// fee-claim strings are ABSENT from every surface listed here, and by the
// coverage guard in discovery-guard-coverage.test.ts, which fails when a new
// agent-readable API route or generated-content module lands without being
// added here (or explicitly allowlisted there as not-a-pure-discovery-surface).
//
// Note: this is a different policy from DISCOVERY_FILES in
// utils/testing/discovery-files.ts — that list covers static public/ files for
// the site-domain/live-routes guards; llms-full.txt is a rich-content surface
// that legitimately carries pricing and so must NOT appear here.

export const PURE_DISCOVERY_SURFACES = [
  "public/llms.txt",
  "public/agents.txt",
  "public/skill.md",
  "public/.well-known/mcp.json",
  "public/.well-known/agent-card.json",
  "public/.well-known/l402.json",
  "pages/api/openapi.json.ts",
  "pages/api/agent-view.ts",
  "pages/api/stall-agent-view.ts",
  "pages/api/.well-known/agent.json.ts",
  "pages/api/.well-known/ucp.ts",
  "utils/geo/stall-content.ts",
  "utils/geo/blog-jsonld.ts",
  "utils/geo/product-jsonld.ts",
];
