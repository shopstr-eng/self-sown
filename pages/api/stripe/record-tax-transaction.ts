import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { applyRateLimit } from "@/utils/rate-limit";
import { withStripeRetry } from "@/utils/stripe/retry-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 60, windowMs: 60000 };

// Records a Stripe Tax transaction from the calculation used at checkout, so the
// seller's Stripe Tax reports reflect the tax actually collected. Best-effort:
// it never blocks the order. The calculation id is read from the (verified,
// succeeded) PaymentIntent's metadata rather than trusted from the client.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "stripe-record-tax-transaction", RATE_LIMIT))
    return;

  try {
    const {
      paymentIntentId,
      connectedAccountId,
    }: { paymentIntentId?: string; connectedAccountId?: string } =
      req.body || {};

    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }
    if (!connectedAccountId || typeof connectedAccountId !== "string") {
      // Tax is only recorded for single-seller direct charges, which always
      // run on a connected account.
      return res
        .status(200)
        .json({ recorded: false, reason: "no_connected_account" });
    }

    const stripeOptions: Stripe.RequestOptions = {
      stripeAccount: connectedAccountId,
    };

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await withStripeRetry(() =>
        stripe.paymentIntents.retrieve(paymentIntentId, stripeOptions)
      );
    } catch (err) {
      console.warn("record-tax-transaction: PI retrieve failed", err);
      return res.status(200).json({ recorded: false, reason: "pi_not_found" });
    }

    if (paymentIntent.status !== "succeeded") {
      return res
        .status(200)
        .json({ recorded: false, reason: "pi_not_succeeded" });
    }

    const calculationId = paymentIntent.metadata?.taxCalculationId;
    if (!calculationId) {
      // No tax was charged on this order.
      return res.status(200).json({ recorded: false, reason: "no_tax" });
    }

    try {
      const transaction = await withStripeRetry(() =>
        stripe.tax.transactions.createFromCalculation(
          {
            calculation: calculationId,
            reference: paymentIntentId,
          },
          {
            ...stripeOptions,
            idempotencyKey: `taxtxn_${paymentIntentId}`,
          }
        )
      );
      return res
        .status(200)
        .json({ recorded: true, transactionId: transaction.id });
    } catch (err: any) {
      const msg = err?.raw?.message || err?.message || "";
      // A transaction for this reference already exists — treat as recorded.
      if (/already|reference/i.test(msg)) {
        return res.status(200).json({ recorded: true, duplicate: true });
      }
      console.warn("record-tax-transaction: createFromCalculation failed", msg);
      return res.status(200).json({ recorded: false, reason: "create_failed" });
    }
  } catch (error) {
    console.error("record-tax-transaction error:", error);
    // Never fail the order over tax reporting.
    return res.status(200).json({ recorded: false, reason: "error" });
  }
}
