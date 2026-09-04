import type { NextApiResponse } from "next";
import type { IncomingMessage, ServerResponse } from "http";

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

// Quality (q) value of an exact media type within an Accept header; 0 when
// absent. q defaults to 1 per RFC 9110.
function acceptQuality(accept: string, mediaType: string): number {
  for (const part of accept.split(",")) {
    const [type, ...params] = part.trim().split(";");
    if (type?.trim().toLowerCase() !== mediaType) continue;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() === "q") {
        const q = parseFloat(value ?? "");
        return Number.isFinite(q) ? q : 1;
      }
    }
    return 1;
  }
  return 0;
}

// True when the client asked for text/markdown (q > 0).
export function acceptsMarkdown(req: IncomingMessage): boolean {
  return acceptQuality(req.headers.accept || "", "text/markdown") > 0;
}

// Markdown 404 for agents that explicitly ask for text/markdown. Kept free of
// product/pricing claims — same discipline as the public discovery files.
export function buildAgentNotFoundMarkdown(
  path: string,
  message?: string
): string {
  return [
    "# 404 Not Found",
    "",
    message ?? `No route matches \`${path}\`.`,
    "",
    "## Where to look next",
    "",
    `- OpenAPI reference: ${AGENT_DOCUMENTATION.openapi}`,
    `- MCP server discovery: ${AGENT_DOCUMENTATION.mcp}`,
    `- Agent overview: ${AGENT_DOCUMENTATION.agents}`,
    "- Documentation index: https://milk.market/llms.txt",
    "",
  ].join("\n");
}

// Markdown 403 for agents that explicitly ask for text/markdown when the
// requested content sits behind a Pro paywall (e.g. a lapsed seller's
// machine-readable stall/blog views). Kept free of product/pricing claims —
// same discipline as the public discovery files.
export function buildAgentProRequiredMarkdown(
  path: string,
  message?: string
): string {
  return [
    "# 403 Pro Required",
    "",
    message ?? `Machine-readable access to \`${path}\` requires an active Pro membership.`,
    "",
    "## Where to look next",
    "",
    `- OpenAPI reference: ${AGENT_DOCUMENTATION.openapi}`,
    `- MCP server discovery: ${AGENT_DOCUMENTATION.mcp}`,
    `- Agent overview: ${AGENT_DOCUMENTATION.agents}`,
    "- Documentation index: https://milk.market/llms.txt",
    "",
  ].join("\n");
}

// Content-negotiated 404 writer shared by the root page catch-all and the
// stall routes (which return Next's `notFound` for browsers). Typed against
// the raw http types so both getServerSideProps (req/res) and API-route
// (NextApiRequest/NextApiResponse) call sites work.
//
// Returns TRUE when the response was written (caller must return `{ props }`
// without rendering) and FALSE when the client wants HTML (caller should
// fall through to its normal browser-facing 404 path).
export function tryWriteAgentNotFound(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  message?: string
): boolean {
  const accept = req.headers.accept || "";
  const htmlQ = acceptQuality(accept, "text/html");
  const mdQ = acceptQuality(accept, "text/markdown");
  // Browsers get the HTML 404 only when HTML is actually the preferred
  // representation — an explicit markdown request wins ties (e.g.
  // "Accept: text/markdown, text/html;q=0.1").
  if (htmlQ > mdQ) return false;

  res.statusCode = 404;
  res.setHeader("Vary", "Accept, User-Agent");
  if (mdQ > 0) {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.end(buildAgentNotFoundMarkdown(path, message));
  } else {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(
        buildAgentError({
          status: 404,
          error: "Not found",
          code: "not_found",
          message: message ?? `No page matches ${path}.`,
          path,
        })
      )
    );
  }
  return true;
}
