import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  claimAuthEventOnce,
  extractNip98EventId,
} from "@/utils/assistant/replay-guard";
import {
  mintAssistantSessionToken,
  SESSION_TOKEN_TTL_MS,
} from "@/utils/assistant/session-token";

// Mints the short-lived bearer token that lets NIP-07/NIP-46 users chat
// without a signing prompt per message. One NIP-98 signature here buys
// SESSION_TOKEN_TTL_MS of token-authed chat requests.
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

  try {
    const { token, expiresAtMs } = mintAssistantSessionToken(auth.pubkey);
    return res.status(200).json({
      token,
      expiresAt: expiresAtMs,
      expiresInSeconds: SESSION_TOKEN_TTL_MS / 1000,
    });
  } catch (error) {
    console.error("assistant session mint failed:", error);
    return res.status(503).json({ error: "Assistant sessions unavailable" });
  }
}
