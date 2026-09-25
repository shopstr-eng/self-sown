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

// Mints the short-lived bearer token that lets NIP-07/NIP-46 users act
// without a signing prompt per request. One NIP-98 signature here buys one
// scope-limited token: the requested scope is part of the signed NIP-98
// payload hash, and the minted token only verifies on endpoints for that
// scope (chat, assistant setup, or MCP key management).
const IP_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const SELLER_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "assistant-session:ip", IP_LIMIT))) {
    return;
  }

  const auth = await verifyNip98Request(req, "POST", req.body);
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
