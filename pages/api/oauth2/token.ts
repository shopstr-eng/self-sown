import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import { verifyIdentityAssertion } from "@/utils/agent-identity-token";
import { createApiKey, initializeApiKeysTable } from "@/utils/mcp/auth";

// RFC 7523 jwt-bearer grant, per the auth.md agent-auth flow
// (https://github.com/workos/auth.md): exchange an identity_assertion from
// /api/agent/identity for an access token. The "access token" here is a REAL
// Self-sown shopping-audience API key (ss_...) created by the same
// createApiKey path as /api/mcp/onboard — the advertised OAuth flow is
// verifiably functional end to end, not metadata theater.

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

let tablesReady = false;
async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    tablesReady = true;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!(await applyRateLimit(req, res, "oauth2-token:ip", RATE_LIMIT))) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendAgentError(res, {
      status: 405,
      error: "Method not allowed",
      code: "method_not_allowed",
      message:
        "Use POST with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer and assertion=<identity_assertion>.",
      method: req.method,
    });
  }

  const body = (req.body ?? {}) as {
    grant_type?: string;
    assertion?: string;
  };

  if (body.grant_type !== JWT_BEARER_GRANT) {
    // RFC 6749 §5.2 error shape so OAuth tooling parses failures natively.
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: `Supported grant_type: ${JWT_BEARER_GRANT}`,
    });
  }

  if (typeof body.assertion !== "string" || body.assertion.length === 0) {
    return res.status(400).json({
      error: "invalid_request",
      error_description:
        "Missing assertion. Obtain one from POST /api/agent/identity.",
    });
  }

  const payload = verifyIdentityAssertion(body.assertion);
  if (!payload) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description:
        "Assertion is invalid or expired. Mint a fresh one from POST /api/agent/identity (10-minute TTL).",
    });
  }

  try {
    await ensureTables();
    const { key, record } = await createApiKey(
      payload.name ?? "agent-auth token exchange",
      payload.sub,
      "read",
      undefined,
      "shopping"
    );
    return res.status(200).json({
      access_token: key,
      token_type: "Bearer",
      scope: "shopping",
      api_key_id: record.id,
      pubkey: payload.sub,
      usage:
        "Send as Authorization: Bearer <access_token> to /api/mcp and the UCP endpoints. Revoke via POST /api/oauth2/revoke.",
    });
  } catch (error) {
    console.error("oauth2/token key issuance failed:", error);
    return res.status(500).json({
      error: "server_error",
      error_description: "Failed to issue an access token.",
    });
  }
}
