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

// Highly sensitive: stores the seller's encrypted nsec on their dedicated
// assistant key row. Tight caps, same posture as /api/mcp/set-nsec.
const IP_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };
const SELLER_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "assistant-setup:ip", IP_LIMIT))) return;

  // GET: lightweight status check so the settings page can show whether write
  // actions are already enabled before the seller sends a message.
  if (req.method === "GET") {
    const getAuth = await verifyNip98Request(req, "GET");
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

  const auth = await verifyNip98Request(req, "POST", req.body);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // Single-use signed requests — this endpoint stores key material.
  if (!claimAuthEventOnce(auth.pubkey, extractNip98EventId(req))) {
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
