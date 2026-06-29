import type { NextApiRequest, NextApiResponse } from "next";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { getSelfHostConfig, isSelfHostTenant } from "@/utils/self-host/config";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 120, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "stripe-connect-seller-status",
      RATE_LIMIT
    ))
  )
    return;

  try {
    const { pubkey } = req.body;

    if (!pubkey) {
      return res.status(400).json({ error: "pubkey is required" });
    }

    // Self-host: card checkout runs on the seller's OWN standard Stripe account
    // (the STRIPE_SECRET_KEY this instance is configured with), not via Connect.
    // Report the card option as available whenever own-Stripe is on, with no
    // connected account id so the payment-intent path charges that key directly.
    const selfHost = getSelfHostConfig();
    if (selfHost.enabled) {
      // Card checkout on a self-host instance runs on the OWNER's own standard
      // Stripe account and applies ONLY to the owner's storefront. Report the
      // card option available solely for the configured tenant pubkey (fail
      // closed for any other pubkey) and only when own-Stripe is configured.
      if (
        isSelfHostTenant(pubkey) &&
        selfHost.ownStripe &&
        process.env.STRIPE_SECRET_KEY
      ) {
        return res.status(200).json({
          hasStripeAccount: true,
          chargesEnabled: true,
          onboardingComplete: true,
        });
      }
      return res.status(200).json({
        hasStripeAccount: false,
        chargesEnabled: false,
      });
    }

    const connectAccount = await getStripeConnectAccount(pubkey);

    if (!connectAccount) {
      return res.status(200).json({
        hasStripeAccount: false,
        chargesEnabled: false,
      });
    }

    return res.status(200).json({
      hasStripeAccount: true,
      chargesEnabled: connectAccount.charges_enabled,
      onboardingComplete: connectAccount.onboarding_complete,
      connectedAccountId: connectAccount.charges_enabled
        ? connectAccount.stripe_account_id
        : undefined,
    });
  } catch (error) {
    console.error("Seller Stripe status check error:", error);
    return res.status(500).json({
      error: "Failed to check seller status",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
