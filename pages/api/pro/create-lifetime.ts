import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProCreateLifetimeProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import {
  ensureWranglerLifetimePrice,
  getOrCreateProCustomer,
  getProStripe,
} from "@/utils/pro/stripe-pro";
import {
  withStripeRetry,
  stableIdempotencyKey,
} from "@/utils/stripe/retry-service";
import { getSellerNotificationEmail } from "@/utils/db/db-service";
import {
  PRO_PRICE_CURRENCY,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";

// Starts a one-time "Wrangler" lifetime purchase on the PLATFORM Stripe account
// (seller = customer). Returns a PaymentIntent client secret for the client to
// confirm the card. Entitlement is granted only when the payment succeeds
// (handled by the `payment_intent.succeeded` webhook), never here.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-create-lifetime", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, email } = req.body || {};
  if (!pubkey) {
    return res.status(400).json({ error: "pubkey is required" });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProCreateLifetimeProof(pubkey)
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  try {
    const stripe = getProStripe();
    // Ensure the lifetime Price exists (find-or-create) so the dashboard shows
    // the purchase alongside the recurring prices; the PaymentIntent itself
    // charges the fixed amount directly.
    await ensureWranglerLifetimePrice();

    const sellerEmail =
      typeof email === "string" && email
        ? email
        : await getSellerNotificationEmail(pubkey);
    const customerId = await getOrCreateProCustomer(pubkey, sellerEmail);

    const paymentIntent = await withStripeRetry(() =>
      stripe.paymentIntents.create(
        {
          customer: customerId,
          amount: WRANGLER_LIFETIME_PRICE_CENTS,
          currency: PRO_PRICE_CURRENCY,
          automatic_payment_methods: { enabled: true },
          metadata: {
            proLifetime: "true",
            mmProPubkey: pubkey,
          },
        },
        {
          // Key on the amount too, so a price change produces a fresh
          // idempotency key instead of reusing a cached old-price PaymentIntent
          // during Stripe's idempotency window.
          idempotencyKey: stableIdempotencyKey("pro-lifetime-create", {
            pubkey,
            amount: WRANGLER_LIFETIME_PRICE_CENTS,
          }),
        }
      )
    );

    return res.status(200).json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ?? null,
    });
  } catch (error) {
    console.error("pro create-lifetime failed:", error);
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to create lifetime purchase",
    });
  }
}
