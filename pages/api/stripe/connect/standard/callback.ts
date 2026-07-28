import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { upsertStripeConnectAccount } from "@/utils/db/db-service";
import { verifyOAuthState } from "@/utils/stripe/standard-oauth";
import { isStandardConnectConfigured } from "@/utils/stripe/connect-config";
import { applyRateLimit } from "@/utils/rate-limit";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 60, windowMs: 60000 };

const SETTINGS_URL = "/settings/payments";
const redirectWith = (res: NextApiResponse, param: string) =>
  res.redirect(`${SETTINGS_URL}?stripe=${param}`);

/**
 * OAuth redirect target for Standard Connect. Stripe sends the seller's
 * browser here with ?code&state (or ?error) after they authorize.
 *
 * This route is unauthenticated by nature — the seller is returning from
 * Stripe — so the HMAC-signed state token is the ONLY thing binding this
 * callback to the seller who started the flow. It must be verified before the
 * code exchange, or anyone could link their Stripe account to a victim's
 * pubkey.
 *
 * Linking REPLACES any existing Connect row for the pubkey (upsert on
 * conflict): this is also the Express -> Standard migration path. The old
 * Express account is left untouched at Stripe (never delete accounts
 * Stripe-side), just unlinked locally.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "stripe-connect-standard-callback",
      RATE_LIMIT
    ))
  )
    return;

  const { code, state, error: oauthError } = req.query;

  // The seller declined (or Stripe errored) on the authorize page.
  if (oauthError) {
    return redirectWith(res, "standard-declined");
  }

  const pubkey = verifyOAuthState(typeof state === "string" ? state : "");
  if (!pubkey || typeof code !== "string" || !code) {
    // Bad/missing state or code: fail closed, exchange nothing.
    return redirectWith(res, "standard-error");
  }

  if (!isStandardConnectConfigured()) {
    return redirectWith(res, "standard-error");
  }

  try {
    const token = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    const stripeAccountId = token.stripe_user_id;
    if (!stripeAccountId) {
      return redirectWith(res, "standard-error");
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    await upsertStripeConnectAccount(
      pubkey,
      stripeAccountId,
      account.details_submitted || false,
      account.charges_enabled || false,
      account.payouts_enabled || false,
      "standard"
    );

    return redirectWith(res, "standard-success");
  } catch (error) {
    console.error("Stripe Standard Connect callback error:", error);
    return redirectWith(res, "standard-error");
  }
}
