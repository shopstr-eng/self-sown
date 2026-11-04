import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";

import { getStripeConnectAccount } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { getSelfHostConfig } from "@/utils/self-host/config";
import { ensureTerminalLocation } from "@/utils/stripe/ensure-terminal-location";
import { withStripeRetry } from "@/utils/stripe/retry-service";

// Stripe Terminal connection token for the mobile PoS. The token is scoped to
// the authenticated seller's OWN connected account (Stripe-Account header), so
// Tap to Pay and any readers discovered with it belong to that seller — a
// seller can never drive another account's readers.
//
// Works for BOTH connected account types (verified against Stripe's Terminal
// Connect docs, 2026-11): direct charges use the platform key + Stripe-Account
// header with no account-type restriction, and the only capability requirement
// is card_payments (there is no separate tap_to_pay capability), which our
// charges_enabled gate below reflects. Standard (seller-owned, OAuth-linked)
// accounts manage their own capabilities, so a seller whose Stripe setup is
// incomplete fails the gate loudly instead of half-working at a market stall.
// The one Standard-specific caveat from Stripe's docs: OAuth-connected
// accounts must be authorized with the platform's client id FOR THE MODE in
// use — a live-mode client id does not cover test-mode tokens and vice versa.
const RATE_LIMIT = { limit: 120, windowMs: 60_000 };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (
    !(await applyRateLimit(req, res, "stripe-terminal-connection", RATE_LIMIT))
  ) {
    return;
  }

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  if (getSelfHostConfig().enabled) {
    return res.status(503).json({
      error: "Card reader payments are not available on this deployment",
      code: "terminal_unavailable",
    });
  }

  const account = await getStripeConnectAccount(authResult.pubkey);
  if (!account?.charges_enabled || !account.onboarding_complete) {
    return res.status(403).json({
      error: "Connect a Stripe account with card charges enabled first",
      code: "stripe_not_connected",
    });
  }

  // Tap to Pay needs a Terminal location on the seller's connected account,
  // and Express sellers have no dashboard to create one — the first
  // connection-token request ensures it (memoized, so repeat taps cost no
  // Stripe round-trip). A seller with no usable address gets a clear,
  // actionable error instead of the SDK's "no location found".
  const location = await ensureTerminalLocation(
    stripe,
    account.stripe_account_id,
    authResult.pubkey
  );
  if (!location.ok) {
    return res.status(location.code === "no_address" ? 422 : 502).json({
      error: location.error,
      code:
        location.code === "no_address"
          ? "terminal_location_missing"
          : "terminal_location_failed",
    });
  }

  try {
    const token = await withStripeRetry(() =>
      stripe.terminal.connectionTokens.create(
        {},
        { stripeAccount: account.stripe_account_id }
      )
    );
    if (!token.secret) {
      throw new Error("Stripe did not return a connection token");
    }
    return res.status(200).json({ secret: token.secret });
  } catch (error) {
    console.error("terminal connection-token failed:", error);
    return res
      .status(502)
      .json({ error: "Could not initialize the card reader" });
  }
}
