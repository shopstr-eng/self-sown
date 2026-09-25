import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  ensureAssistantTables,
  getAssistantSigningState,
  getOrCreateAssistantKey,
  provisionAssistantSigning,
} from "@/utils/assistant/assistant-key";
import {
  claimAuthEventOnce,
  extractNip98EventId,
} from "@/utils/assistant/replay-guard";
import { verifyAssistantSessionToken } from "@/utils/assistant/session-token";

// Highly sensitive: stores the seller's encrypted nsec on their dedicated
// assistant key row. Tight caps, same posture as /api/mcp/set-nsec.
const IP_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };
const SELLER_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

// Two auth schemes, like the chat route: a per-request NIP-98 signature, or a
// short-lived "assistant-setup" session bearer token minted from ONE NIP-98
// signature at /api/assistant/session — so NIP-07/NIP-46 users approve once
// per window instead of once per interaction. Chat-scoped tokens never
// verify here (scope is bound into the token's HMAC).
function resolveAuth(
  req: NextApiRequest,
  method: "GET" | "POST"
): Promise<{ ok: true; pubkey: string; isBearer: boolean } | { ok: false; error: string }> {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const session = verifyAssistantSessionToken(
      authorization.slice(7).trim(),
      "assistant-setup"
    );
    return Promise.resolve(
      session
        ? { ok: true, pubkey: session.pubkey, isBearer: true }
        : { ok: false, error: "Invalid or expired assistant session" }
    );
  }
  // GET auth events carry no payload hash — only pass a body for POST.
  return (method === "POST"
    ? verifyNip98Request(req, method, req.body)
    : verifyNip98Request(req, method)
  ).then((auth) => (auth.ok ? { ...auth, isBearer: false } : auth));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "assistant-setup:ip", IP_LIMIT))) return;

  // GET: lightweight status check so the settings page can show whether write
  // actions are already enabled before the seller sends a message.
  if (req.method === "GET") {
    const getAuth = await resolveAuth(req, "GET");
    if (!getAuth.ok) return res.status(401).json({ error: getAuth.error });
    if (!(await requireProEntitlement(getAuth.pubkey, res))) return;
    try {
      await ensureAssistantTables();
      const row = await getOrCreateAssistantKey(getAuth.pubkey);
      const writesEnabled = await getAssistantSigningState(getAuth.pubkey, row);
      return res.status(200).json({ writesEnabled });
    } catch (error) {
      console.error("assistant status failed:", error);
      return res.status(500).json({ error: "Assistant status failed" });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await resolveAuth(req, "POST");
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // Single-use signed requests — this endpoint stores key material. Bearer
  // tokens are multi-use by design (their single-use NIP-98 mint already ran
  // the replay guard); the short scope TTL + rate limits bound replay.
  if (!auth.isBearer && !claimAuthEventOnce(auth.pubkey, extractNip98EventId(req))) {
    return res
      .status(401)
      .json({ error: "This signed request was already used" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "assistant-setup:seller",
      SELLER_LIMIT,
      auth.pubkey
    ))
  ) {
    return;
  }

  if (!(await requireProEntitlement(auth.pubkey, res))) return;

  const { nsec } = (req.body || {}) as { nsec?: unknown };
  if (typeof nsec !== "string" || !nsec.trim()) {
    return res.status(400).json({ error: "Missing required field: nsec" });
  }

  try {
    await ensureAssistantTables();
    const result = await provisionAssistantSigning(auth.pubkey, nsec);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(200).json({ ok: true, writesEnabled: true });
  } catch (error) {
    console.error("assistant setup failed:", error);
    return res.status(500).json({ error: "Assistant setup failed" });
  }
}
