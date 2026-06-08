import type { NextApiRequest, NextApiResponse } from "next";
import { sendAgentError } from "@/utils/api/agent-error";

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

  res.setHeader("Cache-Control", "no-store");
  sendAgentError(res, {
    status: 404,
    error: "Not found",
    code: "not_found",
    message: `No API endpoint matches ${path}.`,
    path,
    method: req.method,
  });
}
