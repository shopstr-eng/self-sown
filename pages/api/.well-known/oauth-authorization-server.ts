import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import { SITE_URL, originFromHostHeader } from "@/utils/site-url";

// RFC 8414 authorization-server metadata + the WorkOS auth.md `agent_auth`
// extension (https://github.com/workos/auth.md), served at
// /.well-known/oauth-authorization-server on EVERY host — same host-derived
// rule as the RFC 9728 protected-resource metadata: a client builds this URL
// from whatever origin it is calling, so `issuer` and every endpoint must be
// derived from the request Host, never hardcoded to the platform origin.
//
// Every advertised endpoint is real and functional:
//   /api/agent/identity  — mints the identity_assertion (anonymous or
//                          Nostr-proof service_auth)
//   /api/oauth2/token    — RFC 7523 jwt-bearer exchange -> working shopping
//                          API key
//   /api/oauth2/revoke   — RFC 7009 revocation of that key
// identity_types_supported lists ONLY the two types we verify; we do not
// consume third-party ID-JAG assertions, so no identity_assertion block is
// advertised.

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
      "well-known-authorization-server",
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
      message: "Use GET to retrieve the authorization-server metadata.",
      method: req.method,
    });
  }

  const origin = originFromHostHeader(req.headers.host);
  return res.status(200).json({
    issuer: origin,
    token_endpoint: `${origin}/api/oauth2/token`,
    revocation_endpoint: `${origin}/api/oauth2/revoke`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${SITE_URL}/developers`,
    agent_auth: {
      skill: `${origin}/auth.md`,
      identity_endpoint: `${origin}/api/agent/identity`,
      identity_types_supported: ["anonymous", "service_auth"],
    },
  });
}
