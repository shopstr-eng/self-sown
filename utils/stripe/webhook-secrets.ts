import type Stripe from "stripe";

/**
 * Verify a Stripe webhook signature against any of several signing secrets.
 *
 * Each of our webhook route URLs is fronted by TWO Stripe endpoints — an
 * account-scoped one (platform events) and a Connect one (events for objects
 * on sellers' connected accounts) — because a single Stripe endpoint cannot
 * subscribe to both scopes. Stripe signs deliveries with the secret of the
 * endpoint that sent them, so handlers must accept either secret.
 */
export function verifyWithAnySecret(
  stripe: Stripe,
  rawBody: Buffer,
  signature: string | undefined,
  secrets: string[]
): Stripe.Event {
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(
        rawBody,
        signature as string,
        secret
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
