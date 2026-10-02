import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import {
  initializeApiKeysTable,
  revokeApiKey,
  validateApiKey,
} from "@/utils/mcp/auth";

// RFC 7009 token revocation, completing the auth.md agent-auth lifecycle:
// identity -> token -> revoke. The token IS the API key issued by
// /api/oauth2/token, so revocation deactivates that key. Possession of the
// token is the authorization to revoke it (same rule as RFC 7009 public
// clients) — a caller who never had the key cannot guess it (ss_ + 32 random
// bytes), and a caller who has it could only revoke their own credential.

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

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

  if (!(await applyRateLimit(req, res, "oauth2-revoke:ip", RATE_LIMIT))) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendAgentError(res, {
      status: 405,
      error: "Method not allowed",
      code: "method_not_allowed",
      message: "Use POST with token=<access_token>.",
      method: req.method,
    });
  }

  const token = (req.body as { token?: string } | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing token.",
    });
  }

  try {
    await ensureTables();
    const record = await validateApiKey(token);
    if (record) {
      await revokeApiKey(record.id, record.pubkey);
    }
    // RFC 7009 §2.2: 200 whether or not the token existed, so this endpoint
    // cannot be used to probe which keys are valid.
    return res.status(200).json({ revoked: true });
  } catch (error) {
    console.error("oauth2/revoke failed:", error);
    return res.status(500).json({
      error: "server_error",
      error_description: "Failed to revoke the token.",
    });
  }
}
