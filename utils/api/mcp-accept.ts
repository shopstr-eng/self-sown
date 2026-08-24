import type { NextApiRequest } from "next";

/**
 * The MCP SDK's StreamableHTTPServerTransport rejects any POST whose Accept
 * header doesn't include BOTH application/json and text/event-stream with a
 * 406 — including naive agent clients and readiness scanners that send
 * `Accept: application/json`, `Accept: *\/*`, or nothing at all (curl's
 * default). That fails the protocol handshake before it starts even though
 * the server can answer them fine. Default those to the full accept set;
 * pass spec-compliant headers through unchanged.
 */
export function normalizeMcpAcceptHeader(accept: string | undefined): string {
  const FALLBACK = "application/json, text/event-stream";
  if (!accept) return FALLBACK;
  const lower = accept.toLowerCase();
  const hasJson = lower.includes("application/json");
  const hasSse = lower.includes("text/event-stream");
  return hasJson && hasSse ? accept : FALLBACK;
}

/**
 * Apply normalizeMcpAcceptHeader to an in-flight POST. The SDK (>=1.29)
 * bridges Node→Web via @hono/node-server, which builds the Web Request from
 * `req.rawHeaders` — mutating `req.headers.accept` alone never reaches the
 * transport, so the raw array must be kept in sync too.
 */
export function applyMcpAcceptHeader(req: NextApiRequest): void {
  const normalized = normalizeMcpAcceptHeader(req.headers.accept);
  req.headers.accept = normalized;
  const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
  if (idx >= 0) {
    req.rawHeaders[idx + 1] = normalized;
  } else {
    req.rawHeaders.push("Accept", normalized);
  }
}
