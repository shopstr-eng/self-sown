// Shared list of the static agent-discovery files served from public/.
//
// These are the text/markdown/JSON files under public/ and
// public/.well-known/ that advertise links, endpoints, and the site origin
// to agents and crawlers (llms.txt, agents.txt, .well-known/mcp.json, …).
// They are consumed by the geo guard tests (site-domain, live-routes) and
// by the coverage guard in discovery-files-coverage.test.ts, which fails
// when a new agent-facing file lands in public/ without being added here
// (or explicitly allowlisted there as not-a-discovery-file).
//
// Note: discovery-files-no-pricing.test.ts / discovery-files-no-claims.test.ts
// intentionally use their own list — they guard "pure discovery" surfaces
// against fee/marketing claims, which is a different policy (llms-full.txt
// is a rich-content surface that legitimately carries pricing, and their
// list also covers non-public source files).

export const DISCOVERY_FILES = [
  "public/llms.txt",
  "public/llms-full.txt",
  "public/agents.txt",
  "public/skill.md",
  "public/robots.txt",
  "public/humans.txt",
  "public/.well-known/mcp.json",
  "public/.well-known/agent-card.json",
  "public/.well-known/l402.json",
  "public/.well-known/security.txt",
];
