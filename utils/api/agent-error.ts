import type { NextApiResponse } from "next";

// Shared structured-error helper so every machine-readable / agent-facing
// endpoint (the /api catch-all, the platform agent-view, and the per-stall
// agent-view on custom domains) returns the SAME JSON error shape with
// discovery hints. Agents can branch on `code`/`status` instead of scraping
// prose, and always find their way back to the docs from any error.

export const AGENT_DOCUMENTATION = {
  openapi: "https://milk.market/openapi.json",
  mcp: "https://milk.market/.well-known/mcp.json",
  agents: "https://milk.market/agents.txt",
} as const;

export type AgentErrorBody = {
  error: string;
  code: string;
  status: number;
  message?: string;
  path?: string;
  method?: string;
  slug?: string;
  details?: string;
  documentation: typeof AGENT_DOCUMENTATION;
};

export type AgentErrorInit = {
  status: number;
  error: string;
  code: string;
  message?: string;
  path?: string;
  method?: string;
  slug?: string;
  details?: string;
};

export function buildAgentError(init: AgentErrorInit): AgentErrorBody {
  const body: AgentErrorBody = {
    error: init.error,
    code: init.code,
    status: init.status,
    documentation: AGENT_DOCUMENTATION,
  };
  if (init.message !== undefined) body.message = init.message;
  if (init.path !== undefined) body.path = init.path;
  if (init.method !== undefined) body.method = init.method;
  if (init.slug !== undefined) body.slug = init.slug;
  if (init.details !== undefined) body.details = init.details;
  return body;
}

// Writes the structured error to the response with JSON content type. Callers
// are responsible for any caching / CORS headers they want alongside it.
export function sendAgentError(
  res: NextApiResponse,
  init: AgentErrorInit
): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(init.status).json(buildAgentError(init));
}
