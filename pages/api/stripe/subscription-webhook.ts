import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import {
  getSubscriptionByStripeId,
  updateSubscriptionStatus,
  updateSubscriptionBillingDate,
  createSubscriptionNotification,
} from "@/utils/db/db-service";
import {
  sendRenewalReminder,
  sendSubscriptionCancellation,
  sendOrphanedSubscriptionPaymentAlert,
  sendOrphanedSubscriptionCancellationAlert,
} from "@/utils/email/email-service";
import { sendServerSideNostrDM } from "@/utils/nostr/server-nostr-helpers";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { sendDedupedOpsAlert } from "@/utils/email/deduped-ops-alert";
import {
  computeRebateSmallest,
  isAffiliateCodeValid,
  lookupAffiliateCode,
  recordReferral,
} from "@/utils/db/affiliates";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

export const config = {
  api: {
    bodyParser: false,
  },
};
import { applyRateLimit } from "@/utils/rate-limit";
import { verifyWithAnySecret } from "@/utils/stripe/webhook-secrets";
import {
  claimStripeEvent,
  releaseStripeEvent,
} from "@/utils/stripe/processed-events";

async function getRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function formatFrequencyLabel(frequency: string): string {
  const map: Record<string, string> = {
    weekly: "Weekly",
    every_2_weeks: "Every 2 Weeks",
    monthly: "Monthly",
    every_2_months: "Every 2 Months",
    quarterly: "Quarterly",
  };
  return map[frequency] || frequency;
}

function orphanedPaymentAlertDedupKey(stripeSubscriptionId: string): string {
  return `orphaned_subscription_payment_alert:${stripeSubscriptionId}`;
}

/**
 * Email ops about an orphaned subscription payment, deduped per Stripe
 * subscription (see sendDedupedOpsAlert). A legacy subscription nobody
 * cancels stays live at Stripe, so every billing cycle (or a re-sent
 * invoice) would otherwise fire the identical alert; the structured
 * ORPHANED_SUBSCRIPTION_PAYMENT log still records every event. The dedup
 * timestamp is only written after a mail actually goes out, so a transient
 * mail failure re-alerts on the next event, while a genuinely different
 * orphaned subscription always alerts. Never throws — the webhook response
 * must stay 200 because the row will never appear on retry.
 */
async function alertOrphanedSubscriptionPayment(fields: {
  stripeSubscriptionId: string;
  invoiceId: string;
  eventId: string;
  amountPaid: string;
  currency: string;
  customerEmail: string;
  billingReason: string;
}): Promise<void> {
  const outcome = await sendDedupedOpsAlert({
    dedupKey: orphanedPaymentAlertDedupKey(fields.stripeSubscriptionId),
    logTag: "[orphaned_subscription_payment]",
    send: () =>
      sendOrphanedSubscriptionPaymentAlert({
        ...fields,
        adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
      }),
  });
  if (outcome === "suppressed") {
    console.warn(
      `ORPHANED_SUBSCRIPTION_PAYMENT_ALERT_SUPPRESSED stripe_subscription_id=${fields.stripeSubscriptionId} ` +
        `invoice_id=${fields.invoiceId} event_id=${fields.eventId} — ` +
        `ops was already alerted for this subscription within the last 24h`
    );
  }
}

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 300, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "stripe-subscription-webhook", RATE_LIMIT))
  )
    return;

  // See webhook.ts: this URL is fronted by both an account-scoped endpoint
  // (platform Pro subscription renewals) and a Connect endpoint (renewals
  // for subscriptions living on sellers' connected accounts). Each endpoint
  // signs with its own secret, so accept either.
  const webhookSecrets = [
    process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET,
    process.env.STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET,
  ].filter((s): s is string => !!s);
  if (webhookSecrets.length === 0) {
    console.error(
      "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET / STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET not configured"
    );
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  let event: Stripe.Event;

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["stripe-signature"] as string;
    event = verifyWithAnySecret(stripe, rawBody, signature, webhookSecrets);
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  try {
    let claimed = true;
    try {
      claimed = await claimStripeEvent(event.id, event.type);
    } catch (claimErr) {
      console.warn(
        "claimStripeEvent failed (subscription webhook), processing anyway:",
        claimErr
      );
    }
    if (!claimed) {
      return res.status(200).json({ received: true, deduped: true });
    }

    switch (event.type) {
      case "invoice.upcoming": {
        const invoiceUpcoming = event.data.object as any;
        const stripeSubscriptionId =
          typeof invoiceUpcoming.subscription === "string"
            ? invoiceUpcoming.subscription
            : invoiceUpcoming.subscription?.id;

        if (!stripeSubscriptionId) break;

        const subscription =
          await getSubscriptionByStripeId(stripeSubscriptionId);
        if (!subscription) {
          // A renewal reminder is due at Stripe but no local subscriptions
          // row matches, so the buyer never gets warned about the upcoming
          // charge. Returning 200 is correct — retrying will never find the
          // row — but this MUST be loud so ops can reconcile the orphaned
          // subscription. Grep: ORPHANED_SUBSCRIPTION_REMINDER
          console.error(
            `ORPHANED_SUBSCRIPTION_REMINDER stripe_subscription_id=${stripeSubscriptionId} ` +
              `invoice_id=${invoiceUpcoming.id ?? "unknown"} event_id=${event.id} ` +
              `customer_email=${invoiceUpcoming.customer_email ?? "unknown"} — ` +
              `renewal reminder was NOT sent because no subscriptions row matched`
          );
          break;
        }

        const nextBillingDate = subscription.next_billing_date
          ? new Date(subscription.next_billing_date).toLocaleDateString(
              "en-US",
              {
                year: "numeric",
                month: "long",
                day: "numeric",
              }
            )
          : "Upcoming";

        const renewalBranding = await loadStorefrontBranding(
          subscription.seller_pubkey
        );
        await sendRenewalReminder(
          subscription.buyer_email,
          {
            productTitle:
              subscription.product_title || subscription.product_event_id,
            frequency: subscription.frequency,
            discountPercent: Number(subscription.discount_percent),
            regularPrice: String(subscription.base_price),
            subscriptionPrice: String(subscription.subscription_price),
            currency: subscription.currency,
            nextBillingDate,
          },
          renewalBranding
        ).catch((err) =>
          console.error("Failed to send renewal reminder email:", err)
        );

        if (subscription.buyer_pubkey) {
          const dmMessage = `Reminder: Your subscription for "${
            subscription.product_title || subscription.product_event_id
          }" will renew on ${nextBillingDate}. You will be charged ${
            subscription.subscription_price
          } ${subscription.currency.toUpperCase()} (${formatFrequencyLabel(
            subscription.frequency
          )}, ${
            subscription.discount_percent
          }% off). Visit your orders page to manage your subscription.`;

          await sendServerSideNostrDM(
            subscription.buyer_pubkey,
            dmMessage,
            "subscription-renewal"
          ).catch((err) =>
            console.error("Failed to send renewal Nostr DM:", err)
          );
        }

        await createSubscriptionNotification({
          subscription_id: subscription.id,
          type: "renewal_reminder",
          method: subscription.buyer_pubkey ? "both" : "email",
        });

        break;
      }

      case "invoice.payment_succeeded": {
        const invoicePaid = event.data.object as any;
        const paidSubscriptionId =
          typeof invoicePaid.subscription === "string"
            ? invoicePaid.subscription
            : invoicePaid.subscription?.id;

        if (!paidSubscriptionId) break;

        const subscription =
          await getSubscriptionByStripeId(paidSubscriptionId);
        if (!subscription) {
          // Money moved at Stripe but no local subscriptions row matches
          // (e.g. a legacy subscription created before local tracking).
          // Returning 200 is correct — retrying will never find the row —
          // but this MUST be loud so ops can reconcile the orphaned payment
          // and grant the buyer access manually. Grep: ORPHANED_SUBSCRIPTION_PAYMENT
          console.error(
            `ORPHANED_SUBSCRIPTION_PAYMENT stripe_subscription_id=${paidSubscriptionId} ` +
              `invoice_id=${invoicePaid.id ?? "unknown"} event_id=${event.id} ` +
              `amount_paid=${invoicePaid.amount_paid ?? "unknown"} ` +
              `currency=${invoicePaid.currency ?? "unknown"} ` +
              `customer_email=${invoicePaid.customer_email ?? "unknown"} ` +
              `billing_reason=${invoicePaid.billing_reason ?? "unknown"} — ` +
              `renewal charge succeeded but no subscriptions row matched; ` +
              `billing date and status were NOT updated`
          );
          // A log line is only seen if someone goes looking; alert ops
          // directly so a human reconciles promptly. Deduped per Stripe
          // subscription (once per day) so a live legacy subscription can't
          // spam the identical alert every billing cycle, and non-fatal on
          // failure — the 200 above stands because the row will never appear
          // on retry.
          await alertOrphanedSubscriptionPayment({
            stripeSubscriptionId: paidSubscriptionId,
            invoiceId: invoicePaid.id ?? "unknown",
            eventId: event.id,
            amountPaid: String(invoicePaid.amount_paid ?? "unknown"),
            currency: invoicePaid.currency ?? "unknown",
            customerEmail: invoicePaid.customer_email ?? "unknown",
            billingReason: invoicePaid.billing_reason ?? "unknown",
          });
          break;
        }

        // Recurring subscriptions live on the seller's Connect account;
        // retrieving without { stripeAccount } from the platform account
        // would not find them. The row stamps connected_account_id at
        // creation time.
        const subscriptionAccount = (subscription as any)
          .connected_account_id as string | null | undefined;
        const stripeSubscription = (await stripe.subscriptions.retrieve(
          paidSubscriptionId,
          subscriptionAccount
            ? { stripeAccount: subscriptionAccount }
            : undefined
        )) as any;

        // Affiliate referral: record ONLY on the first invoice that creates
        // the subscription. `billing_reason === "subscription_create"`
        // distinguishes the initial charge from recurring renewals, so
        // affiliates are credited (and the buyer only sees the affiliate
        // discount) on the very first payment.
        const subMeta = (stripeSubscription.metadata || {}) as Record<
          string,
          string
        >;
        // The metadata is only stamped by create-subscription.ts when a
        // coupon was actually attached, so its presence is the signal that
        // a discount was applied. We trust the metadata's
        // affiliateBuyerDiscountSmallest as the actual discount (matches
        // what the buyer was charged) and recompute the rebate from that.
        if (
          invoicePaid.billing_reason === "subscription_create" &&
          subMeta.affiliateCode &&
          subMeta.affiliateBuyerDiscountSmallest &&
          subscription.seller_pubkey
        ) {
          try {
            const found = await lookupAffiliateCode(
              subscription.seller_pubkey,
              subMeta.affiliateCode
            );
            if (found && (await isAffiliateCodeValid(found))) {
              const gross = Number(
                subMeta.affiliateGrossSubtotalSmallest ?? "0"
              );
              const buyerDiscountSmallest = Number(
                subMeta.affiliateBuyerDiscountSmallest
              );
              if (
                Number.isFinite(gross) &&
                gross > 0 &&
                Number.isFinite(buyerDiscountSmallest) &&
                buyerDiscountSmallest > 0
              ) {
                const net = Math.max(gross - buyerDiscountSmallest, 0);
                const rebateSmallest = computeRebateSmallest(
                  net,
                  found.rebate_type,
                  Number(found.rebate_value)
                );
                await recordReferral({
                  affiliateId: found.affiliate_id,
                  codeId: found.id,
                  sellerPubkey: subscription.seller_pubkey,
                  orderId: paidSubscriptionId,
                  paymentRail: "stripe",
                  grossSubtotalSmallest: gross,
                  buyerDiscountSmallest,
                  rebateSmallest,
                  currency: subscription.currency,
                  initialStatus: "pending",
                  realtimeTransferRef: null,
                });
              }
            }
          } catch (refErr) {
            console.error(
              "Failed to record affiliate referral for subscription:",
              refErr
            );
          }
        }

        const nextBillingDate = new Date(
          stripeSubscription.current_period_end * 1000
        );

        await updateSubscriptionBillingDate(
          paidSubscriptionId,
          nextBillingDate,
          nextBillingDate
        );

        if (
          subscription.status === "canceled" ||
          subscription.status === "pending"
        ) {
          await updateSubscriptionStatus(paidSubscriptionId, "active");
        }

        if (subscription.buyer_pubkey) {
          const formattedDate = nextBillingDate.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          const dmMessage = `Your subscription payment for "${
            subscription.product_title || subscription.product_event_id
          }" has been processed. Amount: ${
            subscription.subscription_price
          } ${subscription.currency.toUpperCase()}. Next billing date: ${formattedDate}.`;

          await sendServerSideNostrDM(
            subscription.buyer_pubkey,
            dmMessage,
            "subscription-payment"
          ).catch((err) =>
            console.error("Failed to send payment success Nostr DM:", err)
          );
        }

        break;
      }

      case "customer.subscription.deleted": {
        const deletedSubscription = event.data.object as any;

        await updateSubscriptionStatus(deletedSubscription.id, "canceled");

        const subscription = await getSubscriptionByStripeId(
          deletedSubscription.id
        );
        if (!subscription) {
          // Stripe says the subscription is gone but no local subscriptions
          // row matches, so the buyer is never told and a stale dashboard
          // can keep showing it as active. Returning 200 is correct —
          // retrying will never find the row — but this MUST be loud so ops
          // can reconcile the orphaned cancellation manually.
          // Grep: ORPHANED_SUBSCRIPTION_CANCEL
          console.error(
            `ORPHANED_SUBSCRIPTION_CANCEL stripe_subscription_id=${deletedSubscription.id} ` +
              `event_id=${event.id} ` +
              `customer=${deletedSubscription.customer ?? "unknown"} ` +
              `status=${deletedSubscription.status ?? "unknown"} — ` +
              `subscription deleted at Stripe but no subscriptions row matched; ` +
              `buyer cancellation notification was NOT sent`
          );
          // A log line is only seen if someone goes looking; alert ops
          // directly so a human reconciles promptly. Non-fatal on failure —
          // the 200 above stands because the row will never appear on retry.
          await sendOrphanedSubscriptionCancellationAlert({
            stripeSubscriptionId: deletedSubscription.id,
            eventId: event.id,
            customer: deletedSubscription.customer ?? "unknown",
            status: deletedSubscription.status ?? "unknown",
            adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
          }).catch((err) =>
            console.error(
              "[orphaned_subscription_cancel] Failed to send ops alert email:",
              err
            )
          );
        } else {
          const endDate = deletedSubscription.current_period_end
            ? new Date(
                deletedSubscription.current_period_end * 1000
              ).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })
            : new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              });

          const cancelBranding = await loadStorefrontBranding(
            subscription.seller_pubkey
          );
          await sendSubscriptionCancellation(
            subscription.buyer_email,
            {
              productTitle:
                subscription.product_title || subscription.product_event_id,
              endDate,
            },
            cancelBranding
          ).catch((err) =>
            console.error("Failed to send cancellation email:", err)
          );

          if (subscription.buyer_pubkey) {
            const dmMessage = `Your subscription for "${
              subscription.product_title || subscription.product_event_id
            }" has been canceled. You will continue to have access until ${endDate}. No further charges will be made.`;

            await sendServerSideNostrDM(
              subscription.buyer_pubkey,
              dmMessage,
              "subscription-cancellation"
            ).catch((err) =>
              console.error("Failed to send cancellation Nostr DM:", err)
            );
          }

          await createSubscriptionNotification({
            subscription_id: subscription.id,
            type: "cancellation",
            method: subscription.buyer_pubkey ? "both" : "email",
          });
        }

        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook handler error:", error);
    // Release the claim so Stripe's retry is not deduped and can reprocess
    // immediately — otherwise a transient failure (e.g. DB hiccup) would
    // permanently drop the event (e.g. a paid renewal).
    await releaseStripeEvent(event.id).catch((releaseErr) =>
      console.error(
        "subscription webhook claim release failed:",
        releaseErr
      )
    );
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
