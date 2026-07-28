/**
 * Configuration for Stripe Standard Connect (OAuth).
 *
 * Standard Connect lets a seller link their OWN full Stripe account (or create
 * one) through Stripe's OAuth flow — they keep their real Stripe Dashboard and
 * manage everything there, unlike Express accounts which are platform-hosted.
 *
 * The platform's Connect client id (ca_...) appears in the public OAuth
 * authorize URL, so it is NOT a secret — it's a plain env var. The OAuth token
 * exchange uses the existing STRIPE_SECRET_KEY server-side and never leaves
 * the server.
 */

export function getStripeConnectClientId(): string {
  return (process.env.STRIPE_CLIENT_ID || "").trim();
}

export function getStandardConnectRedirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/api/stripe/connect/standard/callback`;
}

/**
 * Fail closed (like Square's isSquareConfigured): a deployment that hasn't set
 * the Connect client id must not start an OAuth flow that would error at
 * Stripe. The base URL is required to build the redirect URI Stripe sends the
 * seller back to.
 */
export function isStandardConnectConfigured(): boolean {
  return !!(
    getStripeConnectClientId() &&
    process.env.STRIPE_SECRET_KEY &&
    process.env.NEXT_PUBLIC_BASE_URL
  );
}
