import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProCheckoutSessionProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import {
  ensureProPrice,
  ensureWranglerLifetimePrice,
  getOrCreateProCustomer,
  getProStripe,
} from "@/utils/pro/stripe-pro";
import {
  withStripeRetry,
  stableIdempotencyKey,
} from "@/utils/stripe/retry-service";
import { getProMembership } from "@/utils/db/pro-membership";
import { getSellerNotificationEmail } from "@/utils/db/db-service";
import { getSiteUrl, isAllowedPlatformRedirectUrl } from "@/utils/site-url";

// Creates a hosted Stripe Checkout Session for a Pro membership purchase and
// returns its URL. Built for the mobile app, which opens the URL in a secure
// browser sheet (the web dashboard uses the in-page PaymentIntent flow in
// /api/pro/create-subscription + /api/pro/create-lifetime instead).
// Entitlement is granted only by the webhook when the payment completes:
// subscription metadata (proMembership/ssProPubkey) flows via
// subscription_data, lifetime metadata (proLifetime/ssProPubkey) via
// payment_intent_data — exactly what pages/api/pro/stripe-webhook.ts consumes.
type CheckoutPlan = "monthly" | "yearly" | "lifetime";

function isCheckoutPlan(value: unknown): value is CheckoutPlan {
  return value === "monthly" || value === "yearly" || value === "lifetime";
}

// The signed proof binds pubkey + plan but NOT the redirect URLs, so a
// stolen proof must not be able to aim the post-payment redirect at a
// lookalike site: https targets are restricted to the platform host and
// only the selfsown:/milkmarket: app deep-link schemes are exempt (they
// cannot load a web page). Shared with the Stripe Connect account-link
// route via isAllowedPlatformRedirectUrl.
function resolveRedirectUrl(
  value: unknown,
  fallbackPath: string
): string | null {
  if (value === undefined || value === null || value === "") {
    return `${getSiteUrl()}${fallbackPath}`;
  }
  if (typeof value !== "string") return null;
  return isAllowedPlatformRedirectUrl(value) ? value : null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-checkout-session", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, plan, successUrl, cancelUrl } = req.body || {};
  if (!pubkey || !isCheckoutPlan(plan)) {
    return res.status(400).json({
      error: "pubkey and a valid plan (monthly|yearly|lifetime) are required",
    });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProCheckoutSessionProof({ pubkey, plan })
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  const success = resolveRedirectUrl(successUrl, "/pro?checkout=success");
  const cancel = resolveRedirectUrl(cancelUrl, "/pro?checkout=cancel");
  if (!success || !cancel) {
    return res.status(400).json({
      error:
        "Redirect URLs must be selfsown:// app links or https URLs on this platform",
    });
  }

  try {
    const membership = await getProMembership(pubkey);
    if (membership?.lifetime) {
      return res
        .status(400)
        .json({ error: "This account already has lifetime (Wrangler) access" });
    }
    if (
      plan !== "lifetime" &&
      membership?.stripe_subscription_id &&
      ["trialing", "active", "grace"].includes(membership.status)
    ) {
      return res.status(400).json({
        error:
          "This account already has a subscription. Manage it from the billing portal instead.",
      });
    }

    const stripe = getProStripe();
    const sellerEmail = await getSellerNotificationEmail(pubkey);
    const customerId = await getOrCreateProCustomer(pubkey, sellerEmail);
    const priceId =
      plan === "lifetime"
        ? await ensureWranglerLifetimePrice()
        : await ensureProPrice(plan);

    const idempotencyKey = stableIdempotencyKey("pro-checkout-session", {
      pubkey,
      plan,
    });

    const session = await withStripeRetry(() =>
      plan === "lifetime"
        ? stripe.checkout.sessions.create(
            {
              mode: "payment",
              customer: customerId,
              line_items: [{ price: priceId, quantity: 1 }],
              success_url: success,
              cancel_url: cancel,
              payment_intent_data: {
                metadata: {
                  proLifetime: "true",
                  // Dual-write: new key canonical; mmProPubkey kept so readers
                  // against pre-rename PaymentIntents keep resolving.
                  ssProPubkey: pubkey,
                  mmProPubkey: pubkey,
                },
              },
              metadata: {
                proLifetime: "true",
                ssProPubkey: pubkey,
                mmProPubkey: pubkey,
              },
            },
            { idempotencyKey }
          )
        : stripe.checkout.sessions.create(
            {
              mode: "subscription",
              customer: customerId,
              line_items: [{ price: priceId, quantity: 1 }],
              success_url: success,
              cancel_url: cancel,
              subscription_data: {
                metadata: {
                  proMembership: "true",
                  ssProPubkey: pubkey,
                  mmProPubkey: pubkey,
                  term: plan,
                },
              },
              metadata: {
                proMembership: "true",
                ssProPubkey: pubkey,
                mmProPubkey: pubkey,
                term: plan,
              },
            },
            { idempotencyKey }
          )
    );

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("pro checkout-session failed:", error);
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to create checkout session",
    });
  }
}
