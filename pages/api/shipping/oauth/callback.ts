import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  exchangeShippoCodeForToken,
  isShippoOAuthConfigured,
} from "@/utils/shipping/shippo-oauth";
import {
  consumeShippoOAuthState,
  upsertShippoConnection,
} from "@/utils/db/shipping-service";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

// Called by the browser redirect page (`/shippo-oauth-redirect`) after Shippo
// sends the user back with `code` + `state`. There is no signed Nostr event at
// this point — authorization is established solely by the single-use `state`
// that was bound to the initiating pubkey when the flow started.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "shipping-oauth-callback", RATE_LIMIT)))
    return;
  if (!isShippoOAuthConfigured()) {
    return res.status(503).json({ error: "Shipping provider not configured" });
  }

  try {
    const { code, state } = (req.body || {}) as {
      code?: string;
      state?: string;
    };
    if (!code || !state) {
      return res.status(400).json({ error: "code and state are required" });
    }

    const pubkey = await consumeShippoOAuthState(state);
    if (!pubkey) {
      return res
        .status(400)
        .json({ error: "Invalid or expired authorization state" });
    }

    const token = await exchangeShippoCodeForToken(code);
    await upsertShippoConnection({
      pubkey,
      accessToken: token.accessToken,
      accountId: token.accountId,
      scope: token.scope,
      status: "connected",
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shippo OAuth callback failed:", message);
    return res.status(500).json({ error: message });
  }
}
