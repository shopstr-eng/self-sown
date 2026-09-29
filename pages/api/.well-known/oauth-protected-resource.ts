import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import { SITE_URL } from "@/utils/site-url";

// RFC 9728 (OAuth 2.0 Protected Resource Metadata) for the Self-sown API.
// Machines read `scopes_supported` here to request least-privilege API keys —
// the same named scopes declared in the OpenAPI bearerAuth x-scopes extension
// and agents.txt. Served at /.well-known/oauth-protected-resource on BOTH the
// platform host and seller custom domains (proxy.ts rewrites it before any
// host-specific routing), like the Web Bot Auth signature directory.
const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Public, cacheable metadata: this document is meant to be discovered.
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (
    !(await applyRateLimit(
      req,
      res,
      "well-known-protected-resource",
      RATE_LIMIT
    ))
  )
    return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendAgentError(res, {
      status: 405,
      error: "Method not allowed",
      code: "method_not_allowed",
      message: "Use GET to retrieve the protected-resource metadata.",
      method: req.method,
    });
  }

  return res.status(200).json({
    // The scopes apply to every /api/* endpoint, so the protected resource is
    // the ORIGIN — which is also what makes the root well-known URL correct
    // per RFC 9728 §3.3 (a resource WITH a path would have to publish at
    // /.well-known/oauth-protected-resource/<path>, and clients MUST NOT use
    // metadata whose resource doesn't match the identifier that generated the
    // URL).
    resource: SITE_URL,
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "read_write", "full_access"],
    resource_documentation: `${SITE_URL}/developers`,
  });
}
