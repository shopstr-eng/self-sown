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
 * Returns:
 *  - null                — no Bearer header present; the caller MUST fall
 *                          back to its signed-request auth (NIP-98 or a
 *                          signed request proof).
 *  - { ok: true, ... }   — a valid session token for `scope` (and
 *                          `bindToPubkey`, when given).
 *  - { ok: false, ... }  — a Bearer header WAS present but the token is
 *                          invalid/expired or bound to another account. The
 *                          caller must reject; falling back to signed-request
 *                          auth would let a mangled-but-signed request smuggle
 *                          past a deliberately-invalid token.
 */
import type { NextApiRequest } from "next";
import {
  verifyAssistantSessionToken,
  type AssistantSessionScope,
} from "@/utils/assistant/session-token";

export type BearerSessionAuth =
  | { ok: true; pubkey: string }
  | { ok: false; status: number; error: string };

export function resolveBearerSessionAuth(
  req: NextApiRequest,
  scope: AssistantSessionScope,
  bindToPubkey?: string
): BearerSessionAuth | null {
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
