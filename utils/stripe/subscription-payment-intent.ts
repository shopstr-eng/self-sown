import Stripe from "stripe";

/**
 * Resolve the first-payment PaymentIntent for a freshly created
 * `default_incomplete` subscription.
 *
 * The SDK pins apiVersion 2025-09-30.clover (Basil family), which REMOVED
 * `Invoice.payment_intent` — `expand: ["latest_invoice.payment_intent"]` on
 * subscription create now silently yields nothing, so keying the buyer's card
 * form off that field returns clientSecret: null and no card form renders.
 * Resolve both ways:
 *   - pre-Basil shape: the expand populated `latest_invoice.payment_intent`
 *     (object or id) — use it directly;
 *   - Basil/clover shape: list the invoice's invoicePayments entries and take
 *     their `payment.payment_intent` id, then retrieve the PaymentIntent for
 *     its client_secret.
 *
 * `stripeOptions` must match the account the subscription was created on
 * (direct charges on a connected account need the stripeAccount header).
 *
 * Throws on Stripe API errors: after subscription creation every caller's
 * retry replays the create idempotently, so a loud 500 + retry is safe and
 * far better than silently shipping a checkout with no card form.
 */
export async function resolveSubscriptionPaymentIntent(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  stripeOptions?: { stripeAccount?: string }
): Promise<Stripe.PaymentIntent | null> {
  const latestInvoice = (subscription as any).latest_invoice;
  const expanded = latestInvoice?.payment_intent;

  // Pre-Basil shape: the expand populated the full PaymentIntent object.
  if (expanded && typeof expanded === "object" && expanded.client_secret) {
    return expanded as Stripe.PaymentIntent;
  }

  let paymentIntentId: string | null = null;
  if (typeof expanded === "string" && expanded) {
    paymentIntentId = expanded;
  } else {
    const invoiceId =
      typeof latestInvoice === "string" ? latestInvoice : latestInvoice?.id;
    if (!invoiceId) return null;
    const payments = await stripe.invoicePayments.list(
      { invoice: invoiceId, limit: 10 },
      stripeOptions
    );
    paymentIntentId =
      (payments.data as any[])
        .map((p) => p?.payment?.payment_intent)
        .find((v): v is string => typeof v === "string" && v.length > 0) ??
      null;
  }

  if (!paymentIntentId) return null;
  return stripe.paymentIntents.retrieve(paymentIntentId, {}, stripeOptions);
}
