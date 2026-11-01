import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";

import { getStripeConnectAccount } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { getSelfHostConfig } from "@/utils/self-host/config";
import {
  stableIdempotencyKey,
  withStripeRetry,
} from "@/utils/stripe/retry-service";

// PoS in-person card charge: a card_present PaymentIntent as a DIRECT charge
// on the authenticated seller's connected account. The caller can only ever
// charge INTO their own account (the account id comes from the DB, keyed by
// the NIP-98-authenticated pubkey — never from the request), so the
// client-supplied amount can only over/under-charge the seller's own customer.
// No application fee: in-person sales skip the platform's online-checkout cut.
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MIN_AMOUNT_SMALLEST = 50;
const MAX_AMOUNT_SMALLEST = 99_999_999;

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
  if (!(await applyRateLimit(req, res, "stripe-terminal-create-pi", RATE_LIMIT)))
    return;

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

  const { amountSmallest, currency, orderId, description } = req.body ?? {};
  if (
    typeof amountSmallest !== "number" ||
    !Number.isInteger(amountSmallest) ||
    amountSmallest < MIN_AMOUNT_SMALLEST ||
    amountSmallest > MAX_AMOUNT_SMALLEST
  ) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    // Card rails are fiat-only; sats/btc never reach this endpoint.
    return res.status(400).json({ error: "Invalid currency" });
  }
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) {
    return res.status(400).json({ error: "Invalid orderId" });
  }
  const descriptionStr =
    typeof description === "string" && description.trim()
      ? description.trim().slice(0, 200)
      : undefined;

  const account = await getStripeConnectAccount(authResult.pubkey);
  if (!account?.charges_enabled || !account.onboarding_complete) {
    return res.status(403).json({
      error: "Connect a Stripe account with card charges enabled first",
      code: "stripe_not_connected",
    });
  }

  try {
    const intent = await withStripeRetry(() =>
      stripe.paymentIntents.create(
        {
          amount: amountSmallest,
          currency: currency.toLowerCase(),
          payment_method_types: ["card_present"],
          capture_method: "automatic",
          ...(descriptionStr ? { description: descriptionStr } : {}),
          metadata: { orderId, source: "self-sown-pos" },
        },
        {
          stripeAccount: account.stripe_account_id,
          idempotencyKey: stableIdempotencyKey("pos-pi", {
            seller: authResult.pubkey,
            orderId,
            amountSmallest,
            currency: currency.toLowerCase(),
          }),
        }
      )
    );
    if (!intent.client_secret) {
      throw new Error("Stripe did not return a client secret");
    }
    return res.status(200).json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
    });
  } catch (error) {
    console.error("terminal create-payment-intent failed:", error);
    return res
      .status(502)
      .json({ error: "Could not create the card payment" });
  }
}
