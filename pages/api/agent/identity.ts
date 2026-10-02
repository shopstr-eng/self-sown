import type { NextApiRequest, NextApiResponse } from "next";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import { mintIdentityAssertion } from "@/utils/agent-identity-token";
import type { McpRequestProof } from "@/utils/mcp/request-proof";
import {
  extractSignedEventFromRequest,
  verifyAndConsumeSignedRequestProof,
} from "@/utils/mcp/request-proof-server";

// auth.md identity endpoint (https://github.com/workos/auth.md): agents POST
// here to obtain a service-signed identity_assertion, then exchange it at
// /api/oauth2/token (RFC 7523 jwt-bearer grant) for a working API key.
//
// Two honest identity types — only what this server actually verifies:
//   anonymous     — no proof required; a fresh keypair is generated and the
//                   assertion (and eventual API key) is bound to its pubkey.
//   service_auth  — caller proves control of an existing Nostr pubkey with a
//                   signed request proof (same mechanism as /api/mcp/onboard);
//                   the assertion is bound to that proven pubkey.
// We do NOT verify third-party ID-JAG assertions, so identity_assertion is
// deliberately absent from identity_types_supported in the AS metadata.

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!(await applyRateLimit(req, res, "agent-identity:ip", RATE_LIMIT)))
    return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendAgentError(res, {
      status: 405,
      error: "Method not allowed",
      code: "method_not_allowed",
      message:
        "Use POST with a JSON body: { type: 'anonymous' | 'service_auth', name?, pubkey?, signedEvent? }.",
      method: req.method,
    });
  }

  const body = (req.body ?? {}) as {
    type?: string;
    name?: string;
    pubkey?: string;
  };
  const type = body.type ?? "anonymous";
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, 100)
      : undefined;

  if (type === "anonymous") {
    const pubkey = getPublicKey(generateSecretKey());
    const assertion = mintIdentityAssertion({
      typ: "anonymous",
      sub: pubkey,
      name,
    });
    return res.status(200).json({
      identity_assertion: assertion,
      assertion_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      identity_type: "anonymous",
      pubkey,
      expires_in: 600,
      token_endpoint: "/api/oauth2/token",
    });
  }

  if (type === "service_auth") {
    const pubkey = typeof body.pubkey === "string" ? body.pubkey.trim() : "";
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      return sendAgentError(res, {
        status: 400,
        error: "Invalid pubkey",
        code: "invalid_pubkey",
        message:
          "service_auth requires a 64-char hex pubkey plus a signedEvent proving control of it.",
      });
    }
    const proof: McpRequestProof = {
      action: "agent-identity",
      method: "POST",
      path: "/api/agent/identity",
      pubkey: pubkey.toLowerCase(),
    };
    const signedEvent = extractSignedEventFromRequest(req);
    const verification = await verifyAndConsumeSignedRequestProof(
      signedEvent,
      proof
    );
    if (!verification.ok) {
      return sendAgentError(res, {
        status: verification.status,
        error: "Identity proof failed",
        code: "identity_proof_failed",
        message: verification.error,
      });
    }
    const assertion = mintIdentityAssertion({
      typ: "service_auth",
      sub: pubkey.toLowerCase(),
      name,
    });
    return res.status(200).json({
      identity_assertion: assertion,
      assertion_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      identity_type: "service_auth",
      pubkey: pubkey.toLowerCase(),
      expires_in: 600,
      token_endpoint: "/api/oauth2/token",
    });
  }

  return sendAgentError(res, {
    status: 400,
    error: "Unsupported identity type",
    code: "unsupported_identity_type",
    message:
      "Supported identity types: 'anonymous' (no proof) and 'service_auth' (signed Nostr event).",
  });
}
