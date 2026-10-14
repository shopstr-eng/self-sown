import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProPortalSessionProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import { getProStripe } from "@/utils/pro/stripe-pro";
import { withStripeRetry } from "@/utils/stripe/retry-service";
import { getProMembership } from "@/utils/db/pro-membership";
import { getSiteUrl } from "@/utils/site-url";

// Creates a Stripe customer portal session for a Pro member and returns its
// URL. Built for the mobile app, which opens the URL in a secure browser
// sheet so sellers can update their card or cancel without a second billing
// backend.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-portal-session", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, returnUrl } = req.body || {};
  if (!pubkey) {
    return res.status(400).json({ error: "pubkey is required" });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProPortalSessionProof(pubkey)
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  // The billing portal only accepts http(s) return URLs; app deep links are
  // rejected here so the mobile app simply refetches status when the sheet
  // closes instead.
  let returnUrlValue = `${getSiteUrl()}/settings/payments`;
  if (returnUrl !== undefined && returnUrl !== null && returnUrl !== "") {
    if (typeof returnUrl !== "string") {
      return res.status(400).json({ error: "returnUrl must be a string" });
    }
    try {
      const parsed = new URL(returnUrl);
      if (parsed.protocol !== "https:") {
        return res.status(400).json({ error: "returnUrl must use https://" });
      }
      returnUrlValue = returnUrl;
    } catch {
      return res.status(400).json({ error: "returnUrl must be a valid URL" });
    }
  }

  try {
    const membership = await getProMembership(pubkey);
    const customerId = membership?.stripe_customer_id;
    if (!customerId) {
      return res
        .status(404)
        .json({ error: "No Stripe billing account on file for this seller" });
    }

    const session = await withStripeRetry(() =>
      getProStripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrlValue,
      })
    );

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("pro portal-session failed:", error);
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to create portal session",
    });
  }
}
