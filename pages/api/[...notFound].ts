import type { NextApiRequest, NextApiResponse } from "next";

// Catch-all for unknown /api/* routes so agents and clients receive a
// structured JSON 404 (with discovery hints) instead of Next.js's default
// HTML error page. More specific API routes always take precedence over this
// catch-all, so existing endpoints are unaffected.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const segments = Array.isArray(req.query.notFound)
    ? req.query.notFound
    : req.query.notFound
      ? [req.query.notFound]
      : [];
  const path = `/api/${segments.join("/")}`;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(404).json({
    error: "Not found",
    code: "not_found",
    status: 404,
    message: `No API endpoint matches ${path}.`,
    path,
    method: req.method,
    documentation: {
      openapi: "https://milk.market/openapi.json",
      mcp: "https://milk.market/.well-known/mcp.json",
      agents: "https://milk.market/agents.txt",
    },
  });
}
