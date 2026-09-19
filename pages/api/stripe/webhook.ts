import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import {
  getStripeConnectAccount,
  getSellerNotificationEmail,
  getSubscriptionByStripeId,
  markStripeConnectDeauthorizedByStripeId,
  syncStripeConnectAccountStateByStripeId,
} from "@/utils/db/db-service";
import {
  sendPaymentFailedToBuyer,
  sendPaymentFailedToSeller,
  sendTransferFailureAlert,
  sendOrphanedStripeEventAlert,
} from "@/utils/email/email-service";

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
  finalizeStripeEvent,
  releaseStripeEvent,
} from "@/utils/stripe/processed-events";
import {
  getPendingPayment,
  getPendingPaymentByIntentId,
  markPendingPaymentByIntent,
  SPLIT_AUTHORITY_METADATA_KEY,
  SPLIT_AUTHORITY_PENDING_RECORD,
} from "@/utils/stripe/pending-payments";
import {
  claimInvoicePayout,
  completeInvoicePayoutClaim,
  releaseInvoicePayoutClaim,
  releaseStaleInvoicePayoutClaim,
} from "@/utils/stripe/payout-claims";
import { computeDonationCutSmallest } from "@/utils/stripe/donation";
import { reverseReferralsForOrder } from "@/utils/db/affiliates";

async function getRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

  if (!(await applyRateLimit(req, res, "stripe-webhook", RATE_LIMIT))) return;

  // Events reach this route from TWO Stripe webhook endpoints on the same
  // URL: an account-scoped endpoint (platform events: application_fee.*,
  // platform payment_intents/invoices) and a Connect endpoint (events for
  // objects on sellers' connected accounts: direct-charge payment_intents,
  // connected-account subscription invoices, account.updated). Stripe signs
  // each endpoint with its own signing secret, so accept either.
  const webhookSecrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_CONNECT_SECRET,
  ].filter((s): s is string => !!s);
  if (webhookSecrets.length === 0) {
    console.error(
      "STRIPE_WEBHOOK_SECRET / STRIPE_WEBHOOK_CONNECT_SECRET not configured"
    );
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  let event: Stripe.Event;

  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers["stripe-signature"] as string;
    event = verifyWithAnySecret(stripe, rawBody, sig, webhookSecrets);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return res
      .status(400)
      .json({ error: "Webhook signature verification failed" });
  }

  // The claim token (claim timestamp) fences releaseStripeEvent: if this
  // worker stalls past the stale window and another worker reclaims the
  // event, this worker's error path must not delete the new owner's claim.
  // Declared outside the try so the catch-site release can read them.
  let claimToken: number | null = null;
  let claimFailed = false;
  try {
    try {
      claimToken = await claimStripeEvent(event.id, event.type);
    } catch (claimErr) {
      // If the claim table is unavailable, fail-open so we still process the
      // event rather than silently dropping it. Duplicate handling will at
      // worst send a duplicate email — preferable to silent loss.
      claimFailed = true;
      console.warn("claimStripeEvent failed, processing anyway:", claimErr);
    }
    if (!claimFailed && claimToken === null) {
      return res.status(200).json({ received: true, deduped: true });
    }

    switch (event.type) {
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(invoice, event);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice, event.id);
        break;
      }
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        try {
          await markPendingPaymentByIntent(pi.id, "succeeded");
        } catch (e) {
          console.warn("markPendingPaymentByIntent succeeded failed:", e);
        }
        // Agent (MCP) card orders are settled here: the agent completes the
        // PaymentIntent on the seller's connected account and Stripe notifies
        // us. (Web card orders are settled client-side and never carry this
        // metadata.) Mark the order paid, then best-effort auto-purchase a
        // shipping label on the seller's own Shippo account if enabled.
        if (pi.metadata?.source === "mcp" && pi.metadata?.orderId) {
          const orderId = pi.metadata.orderId;
          // A DB failure here must throw (500 + claim release → Stripe retry):
          // swallowing it would leave a SETTLED card payment with the order
          // never marked paid and no useful retry. A null return means no
          // mcp_orders row matched — permanent, so be loud and move on (200;
          // retrying will never find the row). Grep: ORPHANED_MCP_ORDER_PAYMENT
          const { updateMcpOrderPayment } =
            await import("@/mcp/tools/purchase-tools");
          const updated = await updateMcpOrderPayment(orderId, pi.id, "paid");
          if (!updated) {
            console.error(
              `ORPHANED_MCP_ORDER_PAYMENT order_id=${orderId} ` +
                `payment_intent=${pi.id} event_id=${event.id} ` +
                `amount=${pi.amount ?? "unknown"} currency=${
                  pi.currency ?? "unknown"
                } — agent card payment settled but no mcp_orders row matched; ` +
                `order was NOT marked paid and no shipping label was purchased`
            );
            // A log line is only seen if someone goes looking; alert ops
            // directly. Non-fatal — the 200 stands because the row will
            // never appear on retry.
            await sendOrphanedStripeEventAlert({
              title: "Orphaned MCP Order Payment",
              marker: "ORPHANED_MCP_ORDER_PAYMENT",
              logTag: "orphaned_mcp_order_payment",
              summary:
                "Agent card payment settled but no mcp_orders row matched; the order was NOT marked paid and no shipping label was purchased.",
              details: [
                { label: "Order", value: orderId },
                { label: "PaymentIntent", value: pi.id },
                { label: "Event", value: event.id },
                {
                  label: "Amount",
                  value: `${pi.amount ?? "unknown"} ${
                    pi.currency ?? "unknown"
                  }`,
                },
              ],
              adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
            }).catch((err) =>
              console.error(
                "[orphaned_mcp_order_payment] Failed to send ops alert email:",
                err
              )
            );
          } else {
            try {
              const { autoPurchaseForMcpOrder } =
                await import("@/utils/shipping/auto-purchase");
              await autoPurchaseForMcpOrder(orderId);
            } catch (e) {
              console.error("Auto label purchase (mcp webhook) failed:", e);
            }
          }
        }
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        try {
          await markPendingPaymentByIntent(
            pi.id,
            "failed_terminal",
            pi.last_payment_error?.message ?? "payment_intent.payment_failed"
          );
        } catch (e) {
          console.warn("markPendingPaymentByIntent failed terminal failed:", e);
        }
        break;
      }
      case "application_fee.created": {
        // Donation collected on the platform account via Connect.
        // Log for reconciliation against orders-dashboard donation totals.
        const fee = event.data.object as Stripe.ApplicationFee;
        const charge =
          typeof fee.charge === "string" ? fee.charge : fee.charge?.id;
        const originatingPi =
          typeof (fee as any).originating_transaction === "string"
            ? (fee as any).originating_transaction
            : (fee as any).originating_transaction?.id;
        console.log(
          `STRIPE_DONATION_COLLECTED fee=${fee.id} amount=${fee.amount} ` +
            `currency=${fee.currency} charge=${charge ?? "?"} ` +
            `account=${
              typeof fee.account === "string" ? fee.account : fee.account?.id
            } pi=${originatingPi ?? "?"}`
        );
        break;
      }
      case "charge.refunded": {
        // Refund reversal for affiliate referrals: when a buyer is refunded
        // we cancel any still-pending referral and mark already-paid ones as
        // 'refunded' so the seller can reconcile out-of-band with the
        // affiliate. We key off paymentIntent.metadata.{orderId,sellerPubkey}
        // because that's what create-payment-intent + cart write through.
        const charge = event.data.object as Stripe.Charge;
        // No try/catch here on purpose: a transient failure (Stripe hiccup on
        // the PI retrieve, DB outage in reverseReferralsForOrder) must surface
        // as a 500 + claim release so Stripe retries. Swallowing it would
        // silently skip the referral reversal and the seller would overpay the
        // affiliate. Retries are safe — the reversal is keyed on event.id. A
        // PI without sellerPubkey metadata simply has no attributable
        // referral, so the no-op is the correct handling for that null case.
        const piId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (piId) {
          // Direct charges live on the seller's connected account; a
          // platform-scope retrieve would 404 them. Connect events carry the
          // account on event.account — scope the retrieve to it.
          const chargeAccount = (event as Stripe.Event & { account?: string })
            .account;
          const pi = await stripe.paymentIntents.retrieve(
            piId,
            chargeAccount ? { stripeAccount: chargeAccount } : undefined
          );
          // Referrals for this charge can live under two keys across the
          // rollout boundary: the canonical PaymentIntent id (current
          // process-transfers) and the legacy client-supplied metadata order
          // id (pre-change rows). Reverse under BOTH — the reversal is
          // idempotent per event, and a key with no matching rows is a no-op.
          const legacyOrderId =
            pi.metadata &&
            typeof pi.metadata.orderId === "string" &&
            pi.metadata.orderId
              ? pi.metadata.orderId
              : null;
          // The authority marker is server-stamped at creation and stripped
          // from caller metadata, so only UNMARKED intents — created before
          // PI-id referral keying shipped — can genuinely carry order-keyed
          // referral rows. On a marked (current) intent metadata.orderId is
          // caller-controlled and must never drive DB mutation.
          const isLegacyReferralEra =
            pi.metadata?.[SPLIT_AUTHORITY_METADATA_KEY] !==
            SPLIT_AUTHORITY_PENDING_RECORD;
          const orderKeys =
            isLegacyReferralEra && legacyOrderId && legacyOrderId !== piId
              ? [piId, legacyOrderId]
              : [piId];
          const pending = await getPendingPaymentByIntentId(piId);
          const recordSplits = pending?.metadata?.sellerSplits;
          if (Array.isArray(recordSplits) && recordSplits.length > 0) {
            // The seller set comes from the authoritative creation-time
            // record — the forgeable metadata sellerPubkey is never
            // consulted on this path, and the legacy order key is only ever
            // applied to those authoritative sellers.
            const sellers = new Set<string>();
            for (const raw of recordSplits) {
              if (!raw || typeof raw !== "object") continue;
              const r = raw as Record<string, unknown>;
              const pk =
                typeof r.sellerPubkey === "string"
                  ? r.sellerPubkey
                  : typeof r.pubkey === "string"
                    ? r.pubkey
                    : null;
              if (pk) sellers.add(pk);
            }
            for (const sp of sellers) {
              for (const key of orderKeys) {
                await reverseReferralsForOrder({
                  orderId: key,
                  sellerPubkey: sp,
                  originalGrossSmallest: charge.amount ?? 0,
                  refundedSmallest: charge.amount_refunded ?? 0,
                  refundEventRef: event.id,
                });
              }
            }
          } else {
            // Recordless legacy intents (single-seller direct charges, or
            // pre-record multi-seller): metadata sellers are all we have.
            const sellerPubkey = pi.metadata?.sellerPubkey;
            if (sellerPubkey) {
              const sellers = sellerPubkey.includes(",")
                ? sellerPubkey.split(",")
                : [sellerPubkey];
              for (const sp of sellers) {
                for (const key of orderKeys) {
                  await reverseReferralsForOrder({
                    orderId: key,
                    sellerPubkey: sp.trim(),
                    // Pass both amounts so the helper can scale the rebate
                    // proportionally on partial refunds instead of clawing
                    // the whole thing back.
                    originalGrossSmallest: charge.amount ?? 0,
                    refundedSmallest: charge.amount_refunded ?? 0,
                    refundEventRef: event.id,
                  });
                }
              }
            }
          }
        }
        break;
      }
      case "application_fee.refunded": {
        const fee = event.data.object as Stripe.ApplicationFee;
        console.log(
          `STRIPE_DONATION_REFUNDED fee=${fee.id} amount_refunded=${fee.amount_refunded} ` +
            `currency=${fee.currency} account=${
              typeof fee.account === "string" ? fee.account : fee.account?.id
            }`
        );
        break;
      }
      case "account.application.deauthorized": {
        // The connected account revoked our OAuth grant. We can no longer
        // initiate transfers, so flip every cached stripe_* flag off; the
        // process-payouts loop already short-circuits on
        // stripe_payouts_enabled=false. The connected-account id arrives on
        // the top-level `event.account` field for Connect events (not on
        // `event.data.object`, which is the Application).
        const acctId = (event as Stripe.Event & { account?: string }).account;
        if (acctId) {
          try {
            const { markAffiliateStripeDeauthorized } =
              await import("@/utils/db/affiliates");
            const matched = await markAffiliateStripeDeauthorized(acctId);
            // A null match is expected, not an orphan: every seller Connect
            // account deauthorization also reaches this endpoint, and seller
            // account state is tracked outside the affiliates table.
            if (matched) {
              console.log(
                `AFFILIATE_STRIPE_DEAUTHORIZED affiliate=${matched} acct=${acctId}`
              );
            }
          } catch (err) {
            console.error(
              "account.application.deauthorized affiliate sync failed:",
              err
            );
          }
          // Marketplace seller Connect accounts live in
          // stripe_connect_accounts, not affiliates. Flip their cached flags
          // off too, or a deauthorized seller keeps looking chargeable.
          // Deliberately NOT wrapped in a swallowing try/catch: a DB outage
          // must surface as a 500 + claim release so Stripe retries, rather
          // than leaving stale flags cached. A null match just means the
          // account isn't a marketplace seller — quiet no-op.
          const sellerMatched =
            await markStripeConnectDeauthorizedByStripeId(acctId);
          if (sellerMatched) {
            console.log(
              `SELLER_STRIPE_DEAUTHORIZED seller=${sellerMatched} acct=${acctId}`
            );
          }
        }
        break;
      }
      case "account.updated": {
        // Mirror Stripe Connect onboarding state into our `affiliates` row so
        // process-payouts can short-circuit on accounts that aren't yet able
        // to receive transfers (charges_enabled / payouts_enabled). We match
        // on `stripe_account_id`; non-affiliate Connect accounts (e.g.
        // marketplace seller accounts handled elsewhere) simply won't match
        // and the no-op is fine.
        const account = event.data.object as Stripe.Account;
        try {
          const { syncAffiliateStripeAccountState } =
            await import("@/utils/db/affiliates");
          const matched = await syncAffiliateStripeAccountState({
            stripeAccountId: account.id,
            chargesEnabled: !!account.charges_enabled,
            payoutsEnabled: !!account.payouts_enabled,
            detailsSubmitted: !!account.details_submitted,
          });
          if (matched) {
            console.log(
              `AFFILIATE_STRIPE_ACCOUNT_UPDATED affiliate=${matched} acct=${account.id} ` +
                `charges=${account.charges_enabled} payouts=${account.payouts_enabled} ` +
                `details=${account.details_submitted}`
            );
          }
        } catch (err) {
          console.error("account.updated affiliate sync failed:", err);
        }
        // Marketplace seller Connect accounts live in stripe_connect_accounts,
        // not affiliates. Sync the same flags into the seller row so stale
        // charges_enabled can't enable transfers Stripe would reject.
        // Deliberately NOT wrapped in a swallowing try/catch: a DB outage
        // must surface as a 500 + claim release so Stripe retries, rather
        // than leaving stale flags cached. A null match just means the
        // account isn't a marketplace seller — quiet no-op.
        const sellerMatched = await syncStripeConnectAccountStateByStripeId({
          stripeAccountId: account.id,
          chargesEnabled: !!account.charges_enabled,
          payoutsEnabled: !!account.payouts_enabled,
          detailsSubmitted: !!account.details_submitted,
        });
        if (sellerMatched) {
          console.log(
            `SELLER_STRIPE_ACCOUNT_UPDATED seller=${sellerMatched} acct=${account.id} ` +
              `charges=${account.charges_enabled} payouts=${account.payouts_enabled} ` +
              `details=${account.details_submitted}`
          );
        }
        break;
      }
      default:
        break;
    }

    // Processing succeeded. Marking the claim 'done' is bookkeeping only — if it
    // fails, DON'T release/500, because the business side effects already ran and
    // a retry would double-process. The claim stays 'processing' with a fresh
    // timestamp, so retries stay deduped until the stale window elapses.
    await finalizeStripeEvent(event.id).catch((finalizeErr) =>
      console.error(
        "stripe webhook finalize failed (processing already succeeded):",
        finalizeErr
      )
    );
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook handler error:", error);
    // Release the claim so Stripe's retry can reprocess immediately — otherwise
    // the un-finalized claim would only be reclaimable after the stale window.
    await releaseStripeEvent(
      event.id,
      claimFailed ? undefined : (claimToken ?? undefined)
    ).catch((releaseErr) =>
      console.error("stripe webhook claim release failed:", releaseErr)
    );
    return res.status(500).json({ error: "Webhook handler error" });
  }
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  eventId: string
) {
  const invoiceAny = invoice as any;
  const subscriptionId = invoiceAny.subscription
    ? typeof invoiceAny.subscription === "string"
      ? invoiceAny.subscription
      : invoiceAny.subscription.id
    : undefined;

  const customerEmail = invoice.customer_email || undefined;
  const amountDue = invoice.amount_due;
  const currency = (invoice.currency || "usd").toUpperCase();
  const amountDisplay = amountDue
    ? `${(amountDue / 100).toFixed(2)} ${currency}`
    : undefined;

  console.error(
    `Invoice payment failed: ${invoice.id}, subscription: ${subscriptionId || "none"}, customer: ${customerEmail || "unknown"}`
  );

  if (customerEmail) {
    await sendPaymentFailedToBuyer(customerEmail, {
      invoiceId: invoice.id,
      subscriptionId,
      amountDisplay,
    }).catch((err) =>
      console.error("Failed to send payment failure email to buyer:", err)
    );
  }

  if (subscriptionId) {
    // A thrown lookup is a transient outage: let it propagate so the webhook
    // 500s, releases the event claim, and Stripe retries (a duplicate buyer
    // email on retry is preferable to silent loss). A null row is permanent —
    // retrying will never find it — so return 200 but be LOUD: the seller is
    // otherwise never told a recurring payment failed.
    // Grep: ORPHANED_SUBSCRIPTION_PAYMENT_FAILED
    const dbSubscription = await getSubscriptionByStripeId(subscriptionId);
    if (!dbSubscription) {
      console.error(
        `ORPHANED_SUBSCRIPTION_PAYMENT_FAILED stripe_subscription_id=${subscriptionId} ` +
          `invoice_id=${invoice.id} event_id=${eventId} ` +
          `customer_email=${customerEmail || "unknown"} ` +
          `amount_due=${amountDue ?? "unknown"} currency=${currency} — ` +
          `recurring payment failed at Stripe but no subscriptions row matched; ` +
          `seller failure notification was NOT sent`
      );
      // A log line is only seen if someone goes looking; alert ops directly.
      // Non-fatal — the 200 stands because the row will never appear on retry.
      await sendOrphanedStripeEventAlert({
        title: "Orphaned Subscription Payment Failure",
        marker: "ORPHANED_SUBSCRIPTION_PAYMENT_FAILED",
        logTag: "orphaned_subscription_payment_failed",
        summary:
          "A recurring payment failed at Stripe but no subscriptions row matched; the seller failure notification was NOT sent.",
        details: [
          { label: "Stripe subscription", value: subscriptionId },
          { label: "Invoice", value: invoice.id ?? "unknown" },
          { label: "Event", value: eventId },
          { label: "Customer email", value: customerEmail || "unknown" },
          {
            label: "Amount due",
            value: `${amountDue ?? "unknown"} ${currency}`,
          },
        ],
        adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
      }).catch((err) =>
        console.error(
          "[orphaned_subscription_payment_failed] Failed to send ops alert email:",
          err
        )
      );
    } else if (dbSubscription.seller_pubkey) {
      try {
        const sellerEmail = await getSellerNotificationEmail(
          dbSubscription.seller_pubkey
        );
        if (sellerEmail) {
          await sendPaymentFailedToSeller(sellerEmail, {
            invoiceId: invoice.id,
            subscriptionId,
            customerEmail,
            amountDisplay,
          });
        }
      } catch (err) {
        console.error("Failed to send payment failure email to seller:", err);
      }
    }
  }
}

function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null;
  return !!e && (e.code === "resource_missing" || e.statusCode === 404);
}

/**
 * Reconciliation for the durable payout-claim window: transfers carry
 * metadata.invoiceId + metadata.sellerPubkey, so a transfer created by a
 * crashed (or pre-claims) attempt can be found and adopted instead of
 * double-paying. Paginated because transfer_group is shared across ALL of
 * a subscription's renewals and grows unbounded over time. Fail-closed:
 * an exhausted search throws (retryable) rather than risking a duplicate.
 */
async function findInvoiceTransfer(
  stripe: Stripe,
  transferGroup: string,
  invoiceId: string,
  sellerPubkey: string
): Promise<Stripe.Transfer | null> {
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await stripe.transfers.list({
      transfer_group: transferGroup,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = list.data.find(
      (t) =>
        t.metadata?.invoiceId === invoiceId &&
        t.metadata?.sellerPubkey === sellerPubkey
    );
    if (match) return match;
    if (!list.has_more || list.data.length === 0) return null;
    startingAfter = list.data[list.data.length - 1]!.id;
  }
  throw new Error(
    `Transfer reconciliation exhausted for invoice ${invoiceId} seller ${sellerPubkey} group ${transferGroup}`
  );
}

async function handleInvoicePaid(invoice: Stripe.Invoice, event: Stripe.Event) {
  const invoiceAny = invoice as any;
  if (!invoiceAny.subscription) return;

  const subscriptionId =
    typeof invoiceAny.subscription === "string"
      ? invoiceAny.subscription
      : invoiceAny.subscription.id;

  // Recurring subscriptions live on the seller's Connect account, so a
  // platform-account retrieve would not find them. Account scope priority:
  // the row's recorded connected_account_id wins; with no row, fall back to
  // the Connect account the event was delivered for (event.account) before
  // trying the platform account. A thrown DB lookup is a transient outage and
  // must propagate (webhook 500 + claim release → Stripe retry) — swallowing
  // it as null would retrieve from the wrong account and misfile a
  // connected-account renewal as orphaned.
  const dbSubscription = await getSubscriptionByStripeId(subscriptionId);
  const connectedAccountId = (dbSubscription as any)?.connected_account_id as
    | string
    | null
    | undefined;
  const eventAccount = (event as Stripe.Event & { account?: string }).account;
  const retrieveAccount = connectedAccountId ?? eventAccount ?? undefined;

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(
      subscriptionId,
      retrieveAccount ? { stripeAccount: retrieveAccount } : undefined
    );
  } catch (err) {
    // No local row AND the subscription is not retrievable under the scope
    // the event was delivered for (platform endpoint → platform account,
    // Connect endpoint → that connected account): the renewal settled on an
    // account we have no record of, so the seller transfers below can never
    // run and retrying is pointless. Return 200 but be LOUD so ops can
    // reconcile the orphaned payment manually.
    // Grep: ORPHANED_SUBSCRIPTION_INVOICE_PAID
    if (!dbSubscription && isStripeResourceMissing(err)) {
      console.error(
        `ORPHANED_SUBSCRIPTION_INVOICE_PAID stripe_subscription_id=${subscriptionId} ` +
          `invoice_id=${invoice.id} event_id=${event.id} ` +
          `account=${retrieveAccount ?? "platform"} ` +
          `amount_paid=${invoiceAny.amount_paid ?? "unknown"} ` +
          `currency=${invoice.currency ?? "unknown"} — ` +
          `invoice paid at Stripe but no subscriptions row matched and the ` +
          `subscription is not retrievable from the delivering account; ` +
          `seller transfers were NOT processed`
      );
      // A log line is only seen if someone goes looking; alert ops directly.
      // Non-fatal — the 200 stands because the row will never appear on retry.
      await sendOrphanedStripeEventAlert({
        title: "Orphaned Subscription Invoice Paid",
        marker: "ORPHANED_SUBSCRIPTION_INVOICE_PAID",
        logTag: "orphaned_subscription_invoice_paid",
        summary:
          "An invoice was paid at Stripe but no subscriptions row matched and the subscription is not retrievable from the delivering account; seller transfers were NOT processed.",
        details: [
          { label: "Stripe subscription", value: subscriptionId },
          { label: "Invoice", value: invoice.id ?? "unknown" },
          { label: "Event", value: event.id },
          { label: "Account", value: retrieveAccount ?? "platform" },
          {
            label: "Amount paid",
            value: `${invoiceAny.amount_paid ?? "unknown"} ${
              invoice.currency ?? "unknown"
            }`,
          },
        ],
        adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
      }).catch((alertErr) =>
        console.error(
          "[orphaned_subscription_invoice_paid] Failed to send ops alert email:",
          alertErr
        )
      );
      return;
    }
    throw err;
  }
  const metadata = subscription.metadata;

  if (metadata.isMultiMerchant !== "true") return;

  const transferGroup = metadata.transferGroup;
  if (!transferGroup) {
    console.error(
      `Multi-merchant subscription ${subscriptionId} missing transferGroup`
    );
    return;
  }

  // Split source of truth: multi-seller recurring carts persist their split
  // details server-side in stripe_pending_payments keyed by the transfer
  // group (the Stripe metadata cap of 500 chars can't hold them), so resolve
  // the record FIRST. A thrown lookup is a transient DB outage and must
  // propagate (webhook 500 + claim release → Stripe retry) — swallowing it
  // as null would fall through to a legacy metadata path that no longer
  // exists for these carts and silently skip every seller payout.
  // Subscriptions created before split persistence carry metadata.sellerSplits
  // and no record; the JSON parse below is their fallback.
  const pendingSplitRecord = await getPendingPayment(transferGroup);

  // Payout-blocking fail-closed: loud marker + ops alert + throw (the 500
  // releases the claim so Stripe retries). Used when the authoritative
  // record is malformed or a nonzero invoice line can't be attributed —
  // paying a partial/remainder set would permanently short some seller.
  // The alert email is AWAITED (with its own catch) before the throw so a
  // serverless teardown after the 500 can't strand it, and an email failure
  // can never eat the throw. Call sites `await` these and do NOT rely on
  // never-call control-flow narrowing — validated values are narrowed with
  // explicit casts/branches instead.
  const failClosedPayoutBlock = async (block: {
    marker: string;
    logTag: string;
    title: string;
    summary: string;
    reason: string;
  }): Promise<never> => {
    console.error(
      `${block.marker} subscription=${subscriptionId} ` +
        `invoice_id=${invoice.id} event_id=${event.id} ` +
        `transferGroup=${transferGroup} reason=${block.reason} — ` +
        `seller transfers were NOT processed`
    );
    await sendOrphanedStripeEventAlert({
      title: block.title,
      marker: block.marker,
      logTag: block.logTag,
      summary: block.summary,
      details: [
        { label: "Stripe subscription", value: subscriptionId },
        { label: "Invoice", value: invoice.id ?? "unknown" },
        { label: "Event", value: event.id },
        { label: "Transfer group", value: transferGroup },
        { label: "Reason", value: block.reason },
      ],
      adminEmail: process.env.DOMAINS_ADMIN_EMAIL,
    }).catch((alertErr) =>
      console.error(
        `[${block.logTag}] Failed to send ops alert email:`,
        alertErr
      )
    );
    throw new Error(
      `${block.marker} for subscription ${subscriptionId}: ${block.reason}`
    );
  };
  // Grep: MALFORMED_SUBSCRIPTION_SPLIT_RECORD
  const failClosedMalformedRecord = (reason: string): Promise<never> =>
    failClosedPayoutBlock({
      marker: "MALFORMED_SUBSCRIPTION_SPLIT_RECORD",
      logTag: "malformed_subscription_split_record",
      title: "Malformed Subscription Split Record",
      summary:
        "A persisted multi-seller subscription split record had malformed entries; seller transfers were NOT processed and the webhook is failing closed until the record is repaired.",
      reason,
    });
  // Grep: UNALLOCATED_INVOICE_LINE
  const failClosedUnattributedLine = (reason: string): Promise<never> =>
    failClosedPayoutBlock({
      marker: "UNALLOCATED_INVOICE_LINE",
      logTag: "unallocated_invoice_line",
      title: "Unattributed Subscription Invoice Line",
      summary:
        "A paid multi-seller subscription invoice had a nonzero line that does not map to any recorded seller price, or no lines at all; seller transfers were NOT processed and the webhook is failing closed until the allocation record is reconciled.",
      reason,
    });
  // Grep: INCOMPLETE_INVOICE_LINES
  const failClosedIncompleteLines = (reason: string): Promise<never> =>
    failClosedPayoutBlock({
      marker: "INCOMPLETE_INVOICE_LINES",
      logTag: "incomplete_invoice_lines",
      title: "Incomplete Subscription Invoice Lines",
      summary:
        "Pagination over a paid multi-seller subscription invoice's line items did not complete (has_more never settled to false); seller transfers were NOT processed and the webhook is failing closed until the full line list can be fetched.",
      reason,
    });

  // Narrow a JSONB metadata field to a non-empty array or fail closed. The
  // explicit cast keeps this compiling regardless of how the TS version
  // treats never-call control-flow narrowing.
  const requireNonEmptyArray = async (
    value: unknown,
    reason: string
  ): Promise<unknown[]> => {
    if (!Array.isArray(value) || value.length === 0) {
      await failClosedMalformedRecord(reason);
    }
    return value as unknown[];
  };

  let sellerSplits: {
    pubkey: string;
    amountCents: number;
    accountId: string;
    donationPercent: number;
  }[];
  if (pendingSplitRecord) {
    sellerSplits = [];
    for (const raw of await requireNonEmptyArray(
      pendingSplitRecord.metadata?.sellerSplits,
      "sellerSplits missing or not a non-empty array"
    )) {
      const r = raw as Record<string, unknown> | null;
      const pubkey = r && typeof r.pubkey === "string" ? r.pubkey : "";
      const amountCents =
        r && typeof r.amountCents === "number" ? r.amountCents : NaN;
      const accountId = r && typeof r.accountId === "string" ? r.accountId : "";
      // The donation percent rides the authority record because the
      // per-invoice derivation below pays NET of this cut. It must be
      // present and sane — never guess 0 for a seller (that would silently
      // waive the platform fee).
      const isPlatformSeller =
        pubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;
      const rawPct = r?.donationPercent;
      // 100% is a supported setting (full donation — see
      // computeDonationCutSmallest); anything above it is malformed.
      const pctValid =
        typeof rawPct === "number" &&
        Number.isFinite(rawPct) &&
        rawPct >= 0 &&
        rawPct <= 100;
      if (
        !pubkey ||
        !Number.isFinite(amountCents) ||
        (!isPlatformSeller && !pctValid)
      ) {
        await failClosedMalformedRecord(
          `invalid split entry: ${JSON.stringify(raw)}`
        );
      }
      sellerSplits.push({
        pubkey,
        amountCents,
        accountId,
        donationPercent: isPlatformSeller ? 0 : (rawPct as number),
      });
    }

    // Static per-seller totals would re-pay EVERY item on EVERY renewal —
    // including one-time items and other cadences absent from this invoice.
    // When the record carries per-price allocations, derive payouts from the
    // actual paid invoice lines instead: each invoice only pays the sellers
    // whose items are on it.
    const allocationsRaw = pendingSplitRecord.metadata?.priceAllocations;
    if (allocationsRaw !== undefined && allocationsRaw !== null) {
      const priceToSeller = new Map<string, string>();
      for (const raw of await requireNonEmptyArray(
        allocationsRaw,
        "priceAllocations present but not a non-empty array"
      )) {
        const a = raw as Record<string, unknown> | null;
        const priceId = a && typeof a.priceId === "string" ? a.priceId : "";
        const sellerPubkey =
          a && typeof a.sellerPubkey === "string" ? a.sellerPubkey : "";
        if (!priceId || !sellerPubkey) {
          await failClosedMalformedRecord(
            `invalid price allocation: ${JSON.stringify(raw)}`
          );
        }
        priceToSeller.set(priceId, sellerPubkey);
      }

      // The embedded invoice.lines only carries the FIRST page of line
      // items, so page through listLineItems in the same account scope used
      // for the subscription retrieve above. Pagination must terminate with
      // has_more === false before ANY transfer — a partial line set would
      // pay only the visible sellers and finalize. Any fetch failure
      // propagates (500 + claim release → Stripe retry).
      if (!invoice.id) {
        await failClosedUnattributedLine(
          "invoice id missing; cannot fetch line items"
        );
      }
      const allLines: any[] = [];
      let startingAfter: string | undefined;
      let hasMore = true;
      let pages = 0;
      while (hasMore) {
        if (++pages > 50) {
          await failClosedIncompleteLines(
            "pagination exceeded 50 pages without has_more settling false"
          );
        }
        const resp: any = await stripe.invoices.listLineItems(
          invoice.id as string,
          {
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          retrieveAccount ? { stripeAccount: retrieveAccount } : undefined
        );
        const pageLines: any[] = Array.isArray(resp?.data) ? resp.data : [];
        if (resp?.has_more === true && pageLines.length === 0) {
          await failClosedIncompleteLines("has_more true with an empty page");
        }
        allLines.push(...pageLines);
        hasMore = resp?.has_more === true;
        if (hasMore) {
          const lastId: unknown = pageLines[pageLines.length - 1]?.id;
          if (typeof lastId !== "string" || !lastId) {
            await failClosedIncompleteLines(
              "page ended without a usable line id cursor"
            );
          }
          startingAfter = lastId as string;
        }
      }
      if (allLines.length === 0) {
        await failClosedUnattributedLine("paid invoice has no line items");
      }

      const accountByPubkey = new Map(
        sellerSplits.map((s) => [s.pubkey, s.accountId])
      );
      const perSeller = new Map<string, number>();
      for (const line of allLines) {
        const amount = typeof line?.amount === "number" ? line.amount : 0;
        // $0 lines (trials, full-credit offsets) pay nobody — skip them.
        if (amount === 0) continue;
        // Invoice line price id — shape moved across API versions
        // (line.price vs line.pricing.price_details.price), accept both.
        const priceId: string | null =
          typeof line?.price === "string"
            ? line.price
            : (line?.price?.id ?? line?.pricing?.price_details?.price ?? null);
        const seller = priceId ? priceToSeller.get(priceId) : undefined;
        if (seller) {
          perSeller.set(seller, (perSeller.get(seller) ?? 0) + amount);
        } else {
          // A nonzero line we can't attribute must NEVER be guessed at or
          // silently kept on the platform account — that permanently shorts
          // a seller. Fail closed so ops reconciles before any payout.
          await failClosedUnattributedLine(
            `price=${priceId ?? "unknown"} amount=${amount}`
          );
        }
      }
      const donationPctByPubkey = new Map(
        sellerSplits.map((s) => [s.pubkey, s.donationPercent])
      );
      sellerSplits = [...perSeller.entries()]
        .filter(([, grossCents]) => grossCents > 0)
        .map(([pubkey, grossCents]) => {
          // Pay NET of the seller's donation/platform-fee cut, computed from
          // THIS invoice's actual per-seller amount (never the static
          // creation-time totals) — parity with single-seller subscriptions
          // (application_fee_percent) and one-time multi-seller payouts.
          const pct = donationPctByPubkey.get(pubkey);
          if (typeof pct !== "number") {
            // Unreachable (perSeller keys come from the validated record
            // splits) — but never guess 0 and silently waive the fee.
            throw new Error(
              `no validated donationPercent for seller ${pubkey}`
            );
          }
          const cut = computeDonationCutSmallest(grossCents, pct);
          return {
            pubkey,
            amountCents: grossCents - cut,
            accountId: accountByPubkey.get(pubkey) ?? "",
            donationPercent: pct,
          };
        });
    }
  } else {
    if (
      metadata[SPLIT_AUTHORITY_METADATA_KEY] === SPLIT_AUTHORITY_PENDING_RECORD
    ) {
      // Marked record-era subscription with a MISSING record: falling
      // through to the legacy metadata parse would find nothing (current
      // carts omit metadata.sellerSplits) and 200 with zero payouts. Fail
      // closed instead. (Awaited; the throw keeps this branch from ever
      // reaching the legacy parse at runtime.)
      // Grep: MISSING_SUBSCRIPTION_SPLIT_RECORD
      await failClosedPayoutBlock({
        marker: "MISSING_SUBSCRIPTION_SPLIT_RECORD",
        logTag: "missing_subscription_split_record",
        title: "Missing Subscription Split Record",
        summary:
          "A record-era multi-seller subscription (authority marker present) has no pending split record; seller transfers were NOT processed and the webhook is failing closed until the record is restored.",
        reason: "authority marker present but no pending split record found",
      });
    }
    try {
      sellerSplits = JSON.parse(metadata.sellerSplits || "[]");
    } catch {
      console.error(
        `Failed to parse sellerSplits for subscription ${subscriptionId}`
      );
      return;
    }
  }

  if (sellerSplits.length === 0) return;

  const paymentIntentId =
    typeof invoiceAny.payment_intent === "string"
      ? invoiceAny.payment_intent
      : invoiceAny.payment_intent?.id;

  const transferCurrency = invoice.currency || "usd";

  const failedTransfers: {
    pubkey: string;
    amountCents: number;
    error: string;
  }[] = [];
  // transfers.create failures are RETRYABLE (500 → claim release → Stripe
  // retry, safe via per-invoice/per-seller idempotency keys); resolution
  // failures (seller has no Stripe account) are permanent and alert-only.
  const retryableTransferFailures: string[] = [];

  // Resolve any missing Connect account ids for ALL splits BEFORE creating
  // the first transfer. getStripeConnectAccount rethrows on DB error, and
  // that throw must abort here — transfers.create below is not idempotent
  // across a webhook retry, so a lookup outage mid-loop would 500 with some
  // sellers already paid and the retry would pay them again. Aborting before
  // any money moves makes the 500 + claim release + Stripe retry safe.
  // A null row is permanent (seller genuinely has no account) and stays a
  // per-split failedTransfer + ops alert, never a retry.
  const resolvedAccountIds = new Map<string, string>();
  for (const split of sellerSplits) {
    if (split.pubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK) continue;
    if (split.accountId) continue;
    const connectAccount = await getStripeConnectAccount(split.pubkey);
    if (!connectAccount || !connectAccount.charges_enabled) {
      const msg = `Cannot transfer to seller ${split.pubkey} — no Stripe account`;
      console.error(msg);
      failedTransfers.push({
        pubkey: split.pubkey,
        amountCents: split.amountCents,
        error: msg,
      });
      continue;
    }
    resolvedAccountIds.set(split.pubkey, connectAccount.stripe_account_id);
  }

  for (const split of sellerSplits) {
    const isPlatformAccount =
      split.pubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;
    if (isPlatformAccount) continue;

    const accountId = split.accountId || resolvedAccountIds.get(split.pubkey);
    if (!accountId) continue; // already recorded in failedTransfers above

    // Only release/complete a claim WE created during this attempt, and
    // only with OUR fencing token — a stale takeover rotates the token, so
    // a resumed previous owner's writes match zero rows, and a live
    // co-attempt's row is never touched.
    let ownsClaimThisAttempt = false;
    let claimTokenThisAttempt: string | null = null;
    try {
      // Durable (invoice, seller) payout claim BEFORE any transfer: Stripe
      // idempotency keys expire after ~24h but invoice.paid retries can
      // arrive for days, so the key alone cannot prevent a double payout on
      // a late retry. A completed claim means this seller is already paid
      // for this invoice — skip without calling Stripe at all.
      let claim = await claimInvoicePayout(invoice.id, split.pubkey);
      if (!claim.created && claim.transferId) continue;
      if (!claim.created) {
        // Incomplete claim: a live in-flight attempt owns it, or a crashed
        // one left it stale. Take over only a PROVABLY stale claim so a
        // live attempt's row is never deleted mid-flight. A live-owned
        // unresolved claim is NOT proof of payment: finalizing here would
        // strand this seller if the owner crashed, so fail retryable —
        // Stripe's next retry finds the claim completed or takes it over
        // once it is stale.
        await releaseStaleInvoicePayoutClaim(
          invoice.id,
          split.pubkey,
          10 * 60 * 1000
        );
        claim = await claimInvoicePayout(invoice.id, split.pubkey);
        if (!claim.created) {
          throw new Error(
            `Payout claim for invoice ${invoice.id} seller ${split.pubkey} is owned by an in-flight attempt`
          );
        }
      }
      ownsClaimThisAttempt = true;
      claimTokenThisAttempt = claim.claimToken;
      if (split.amountCents <= 0) {
        // A 100% donation legitimately consumes the seller's whole share —
        // no transfer exists to create (Stripe rejects 0-amount). Record a
        // terminal sentinel on the claim so this seller is durably resolved
        // and retries never reprocess (or fail) the paid invoice forever.
        await completeInvoicePayoutClaim(
          invoice.id,
          split.pubkey,
          `full-donation:${invoice.id}:${split.pubkey}`,
          claimTokenThisAttempt
        );
        continue;
      }
      // We own the claim — but a fresh claim proves nothing about pre-claim
      // history (crash between transfer and record, or payouts predating
      // claims), and the idempotency key below expires in ~24h. Reconcile
      // against the transfer history and adopt any match before creating.
      const existingTransfer = await findInvoiceTransfer(
        stripe,
        transferGroup,
        invoice.id,
        split.pubkey
      );
      if (existingTransfer) {
        await completeInvoicePayoutClaim(
          invoice.id,
          split.pubkey,
          existingTransfer.id,
          claimTokenThisAttempt
        );
        continue;
      }

      // Deterministic idempotency key covers the <24h retry window; the
      // claim above is the durable backstop beyond it. Keyed on invoice.id
      // + seller pubkey (NOT transferGroup, which is shared across a
      // subscription's renewals).
      const transfer = await stripe.transfers.create(
        {
          amount: split.amountCents,
          currency: transferCurrency,
          destination: accountId,
          transfer_group: transferGroup,
          metadata: {
            subscriptionId,
            invoiceId: invoice.id,
            sellerPubkey: split.pubkey,
            paymentIntentId: paymentIntentId || "",
          },
        },
        { idempotencyKey: `invoice-${invoice.id}-transfer-${split.pubkey}` }
      );
      await completeInvoicePayoutClaim(
        invoice.id,
        split.pubkey,
        transfer.id,
        claimTokenThisAttempt
      );
    } catch (error) {
      // Release OUR claim so a retry can re-attempt (only deletes rows with
      // no recorded transfer — a completed claim is untouched; a crash
      // between transfer and completion is covered by the history
      // reconciliation above on the next attempt). Claims owned by a live
      // co-attempt are never touched.
      if (ownsClaimThisAttempt) {
        await releaseInvoicePayoutClaim(
          invoice.id,
          split.pubkey,
          claimTokenThisAttempt
        ).catch(() => {});
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `Transfer failed for seller ${split.pubkey} on subscription ${subscriptionId}:`,
        error
      );
      failedTransfers.push({
        pubkey: split.pubkey,
        amountCents: split.amountCents,
        error: msg,
      });
      retryableTransferFailures.push(split.pubkey);
    }
  }

  if (failedTransfers.length > 0) {
    console.error(
      `TRANSFER_FAILURES subscription=${subscriptionId} invoice=${
        invoice.id
      } transferGroup=${transferGroup} failures=${JSON.stringify(
        failedTransfers
      )}`
    );

    try {
      // Ops-side alert only: sendTransferFailureAlert resolves the shared ops
      // recipient (explicit admin email > verified platform sender), never a
      // seller's notification email.
      await sendTransferFailureAlert({
        subscriptionId,
        invoiceId: invoice.id,
        failures: failedTransfers.map((f) => ({
          sellerPubkey: f.pubkey,
          amountCents: f.amountCents,
          error: f.error,
        })),
      });
    } catch (emailErr) {
      console.error("Failed to send transfer failure alert email:", emailErr);
    }

    // ANY retryable transfer failure must fail the webhook: the resulting
    // 500 + claim release + Stripe retry is the ONLY reconciliation that can
    // still pay that seller, and the per-invoice/per-seller idempotency keys
    // above make the retry safe for sellers already paid. Finalizing the
    // event here would leave that seller permanently unpaid.
    if (retryableTransferFailures.length > 0) {
      throw new Error(
        `Retryable seller transfer failure(s) for subscription ${subscriptionId}: ${retryableTransferFailures.join(", ")}`
      );
    }
  }
}
