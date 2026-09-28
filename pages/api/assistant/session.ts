import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  claimAuthEventOnce,
  extractNip98EventId,
} from "@/utils/assistant/replay-guard";
import {
  isAssistantSessionScope,
  mintAssistantSessionToken,
  SESSION_SCOPES,
  SESSION_SCOPE_TTLS_MS,
  type AssistantSessionScope,
} from "@/utils/assistant/session-token";
import { revokeAssistantSessions } from "@/utils/assistant/session-revocation";

// Mints the short-lived bearer token that lets NIP-07/NIP-46 users act
// without a signing prompt per request. One NIP-98 signature here buys one
// scope-limited token: the requested scope is part of the signed NIP-98
// payload hash, and the minted token only verifies on endpoints for that
// scope (chat, assistant setup, or MCP key management).
//
// DELETE is the targeted kill switch: the tokens are stateless HMAC and
// otherwise verify until their TTL no matter what (short of rotating
// SESSION_SECRET, which logs out EVERY seller). A signed DELETE stamps the
// seller's "revoked before now" record, and the shared bearer preamble
// rejects any of that seller's tokens issued at or before the stamp — every
// scope at once, no other seller affected.
const IP_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const SELLER_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "assistant-session:ip", IP_LIMIT))) {
    return;
  }

  // DELETE carries no body, so there is no payload hash to verify.
  const auth =
    req.method === "DELETE"
      ? await verifyNip98Request(req, "DELETE")
      : await verifyNip98Request(req, "POST", req.body);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // Single-use signed requests, same as the chat route's NIP-98 path.
  if (!claimAuthEventOnce(auth.pubkey, extractNip98EventId(req))) {
    return res
      .status(401)
      .json({ error: "This signed request was already used" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "assistant-session:seller",
      SELLER_LIMIT,
      auth.pubkey
    ))
  ) {
    return;
  }

  // Revoke is NOT Pro-gated: killing a suspected-leaked token is a safety
  // action and must stay available to a seller whose membership lapsed.
  if (req.method === "DELETE") {
    try {
      const revokedBefore = await revokeAssistantSessions(auth.pubkey);
      return res.status(200).json({ ok: true, revokedBefore });
    } catch (error) {
      console.error("assistant session revoke failed:", error);
      return res.status(503).json({ error: "Assistant sessions unavailable" });
    }
  }

  // Pro-only feature — the chat route re-checks entitlement on every request;
  // gating the mint too means a lapsed seller never gets a token in the first
  // place.
  if (!(await requireProEntitlement(auth.pubkey, res))) return;

  // The requested scope is covered by the NIP-98 payload hash, so it cannot
  // be swapped after signing. Absent scope = chat (original clients).
  const rawScope = (req.body as { scope?: unknown } | undefined)?.scope;
  const scope: AssistantSessionScope =
    rawScope === undefined
      ? SESSION_SCOPES.chat
      : (rawScope as AssistantSessionScope);
  if (!isAssistantSessionScope(scope)) {
    return res.status(400).json({ error: "Unknown session scope" });
  }

  try {
    const { token, expiresAtMs } = mintAssistantSessionToken(
      auth.pubkey,
      scope
    );
    return res.status(200).json({
      token,
      expiresAt: expiresAtMs,
      expiresInSeconds: SESSION_SCOPE_TTLS_MS[scope] / 1000,
      scope,
    });
  } catch (error) {
    console.error("assistant session mint failed:", error);
    return res.status(503).json({ error: "Assistant sessions unavailable" });
  }
}
