import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";

import { getStripeConnectAccount } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { getSelfHostConfig } from "@/utils/self-host/config";
import { withStripeRetry } from "@/utils/stripe/retry-service";

// Stripe Terminal connection token for the mobile PoS. The token is scoped to
// the authenticated seller's OWN connected account (Stripe-Account header), so
// Tap to Pay and any readers discovered with it belong to that seller — a
// seller can never drive another account's readers.
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
