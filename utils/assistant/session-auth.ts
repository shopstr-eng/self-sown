/**
 * Shared Bearer-token preamble for the approve-once session auth scheme.
 *
 * Every endpoint that accepts an assistant session token runs the same
 * preamble: pull the Authorization header, and when it is a Bearer token,
 * verify it against THIS endpoint's scope (from SESSION_SCOPES, never an
 * inline literal). Keeping that preamble here — instead of hand-rolled per
 * route — means a fix (or a regression) to header parsing, scope binding, or
 * pubkey binding applies to every consumer at once.
 *
 * Per-seller revocation: after the stateless checks pass, the token's
 * issued-at is compared against the seller's "revoked before" stamp so a
 * seller who suspects a leak can kill their outstanding tokens without a
 * global SESSION_SECRET rotation. The stamp lookup FAILS CLOSED: a DB error
 * rejects the request (503) instead of waving a possibly-revoked token
 * through during an outage.
 *
 * Returns:
 *  - null                — no Bearer header present; the caller MUST fall
 *                          back to its signed-request auth (NIP-98 or a
 *                          signed request proof).
 *  - { ok: true, ... }   — a valid session token for `scope` (and
 *                          `bindToPubkey`, when given).
 *  - { ok: false, ... }  — a Bearer header WAS present but the token is
 *                          invalid/expired/revoked or bound to another
 *                          account. The caller must reject; falling back to
 *                          signed-request auth would let a mangled-but-signed
 *                          request smuggle past a deliberately-invalid token.
 */
import type { NextApiRequest } from "next";
import {
  verifyAssistantSessionToken,
  type AssistantSessionScope,
} from "@/utils/assistant/session-token";
import { getAssistantSessionRevokedBefore } from "@/utils/assistant/session-revocation";

export type BearerSessionAuth =
  | { ok: true; pubkey: string }
  | { ok: false; status: number; error: string };

export async function resolveBearerSessionAuth(
  req: NextApiRequest,
  scope: AssistantSessionScope,
  bindToPubkey?: string
): Promise<BearerSessionAuth | null> {
  const authorization = req.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return null;
  }

  const session = verifyAssistantSessionToken(
    authorization.slice("Bearer ".length).trim(),
    scope
  );
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired assistant session",
    };
  }

  // Targeted kill switch: tokens issued at or before the seller's
  // revocation stamp are dead even though their HMAC + expiry still check
  // out. Fail closed when the stamp can't be read.
  let revokedBefore: number | null;
  try {
    revokedBefore = await getAssistantSessionRevokedBefore(session.pubkey);
  } catch (error) {
    console.error("assistant session revocation check failed:", error);
    return {
      ok: false,
      status: 503,
      error: "Assistant sessions temporarily unavailable",
    };
  }
  if (revokedBefore !== null && session.issuedAtMs <= revokedBefore) {
    return {
      ok: false,
      status: 401,
      error: "This assistant session has been revoked",
    };
  }

  // Endpoints whose request names an account (e.g. MCP key management passes
  // the target pubkey in the body/query) must bind the token to it, or one
  // seller's token could manage another seller's credentials.
  if (bindToPubkey !== undefined && session.pubkey !== bindToPubkey) {
    return {
      ok: false,
      status: 403,
      error: "Session token does not match this account",
    };
  }

  return { ok: true, pubkey: session.pubkey };
}
