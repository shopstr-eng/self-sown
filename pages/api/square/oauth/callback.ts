import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { exchangeSquareCodeForToken } from "@/utils/square/square-oauth";
import {
  consumeSquareOAuthState,
  upsertSquareConnection,
} from "@/utils/db/square-service";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import {
  fetchSquareLocations,
  pickPrimaryLocation,
} from "@/utils/square/square-api";
import {
  SQUARE_OAUTH_SCOPES,
  isSquareConfigured,
} from "@/utils/square/square-config";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

// Called by the browser redirect page (`/square-oauth-redirect`) after Square
// sends the seller back with `code` + `state`. There is no signed Nostr event
// here — authorization is established solely by the single-use `state` that was
// bound to the initiating pubkey when the flow started.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "square-oauth-callback", RATE_LIMIT)))
    return;
  if (!isSquareConfigured()) {
    return res.status(503).json({ error: "Square is not configured" });
  }

  try {
    const { code, state } = (req.body || {}) as {
      code?: string;
      state?: string;
    };
    if (!code || !state) {
      return res.status(400).json({ error: "code and state are required" });
    }

    const pubkey = await consumeSquareOAuthState(state);
    if (!pubkey) {
      return res
        .status(400)
        .json({ error: "Invalid or expired authorization state" });
    }

    // Re-check the XOR at completion: a seller could have connected Stripe in
    // the window between starting and finishing the Square flow. Never store a
    // Square connection for a pubkey that already has Stripe.
    const stripe = await getStripeConnectAccount(pubkey);
    if (stripe && stripe.stripe_account_id) {
      return res.status(409).json({
        error:
          "Stripe is already connected. Disconnect Stripe before connecting Square.",
        code: "stripe_connected",
      });
    }

    const token = await exchangeSquareCodeForToken(code);

    // Resolve the seller's primary location + its currency so checkout can
    // refuse a cart-currency mismatch later.
    let locationId: string | null = null;
    let locationCurrency: string | null = null;
    try {
      const locations = await fetchSquareLocations(token.accessToken);
      const primary = pickPrimaryLocation(locations);
      locationId = primary?.id ?? null;
      locationCurrency = primary?.currency ?? null;
    } catch (e) {
      // Non-fatal: store the connection; the seller can re-sync, and checkout
      // fails closed (no location => Square not offered) until resolved.
      console.warn("Square location fetch failed during callback:", e);
    }

    await upsertSquareConnection({
      pubkey,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      merchantId: token.merchantId,
      locationId,
      locationCurrency,
      scope: SQUARE_OAUTH_SCOPES.join(" "),
      status: "connected",
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Square OAuth callback failed:", message);
    return res.status(500).json({ error: message });
  }
}
