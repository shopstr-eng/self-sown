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
import { markPendingPaymentByIntent } from "@/utils/stripe/pending-payments";
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

  try {
    let claimed = true;
    try {
      claimed = await claimStripeEvent(event.id, event.type);
    } catch (claimErr) {
      // If the claim table is unavailable, fail-open so we still process the
      // event rather than silently dropping it. Duplicate handling will at
      // worst send a duplicate email — preferable to silent loss.
      console.warn("claimStripeEvent failed, processing anyway:", claimErr);
    }
    if (!claimed) {
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
          const orderId = (pi.metadata && pi.metadata.orderId) || piId;
          const sellerPubkey = pi.metadata?.sellerPubkey;
          if (sellerPubkey) {
            const sellers = sellerPubkey.includes(",")
              ? sellerPubkey.split(",")
              : [sellerPubkey];
            for (const sp of sellers) {
              await reverseReferralsForOrder({
                orderId,
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
    await releaseStripeEvent(event.id).catch((releaseErr) =>
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

  let sellerSplits: {
    pubkey: string;
    amountCents: number;
    accountId: string;
  }[];
  try {
    sellerSplits = JSON.parse(metadata.sellerSplits || "[]");
  } catch {
    console.error(
      `Failed to parse sellerSplits for subscription ${subscriptionId}`
    );
    return;
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
  const nonPlatformSplits = sellerSplits.filter(
    (s) => s.pubkey !== process.env.NEXT_PUBLIC_MILK_MARKET_PK
  );

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
    if (split.pubkey === process.env.NEXT_PUBLIC_MILK_MARKET_PK) continue;
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
      split.pubkey === process.env.NEXT_PUBLIC_MILK_MARKET_PK;
    if (isPlatformAccount) continue;

    const accountId = split.accountId || resolvedAccountIds.get(split.pubkey);
    if (!accountId) continue; // already recorded in failedTransfers above

    try {
      await stripe.transfers.create({
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
      });
    } catch (error) {
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
      const dbSubscription = await getSubscriptionByStripeId(subscriptionId);
      const sellerPubkey = dbSubscription?.seller_pubkey;
      let alertEmail: string | null = null;

      if (sellerPubkey) {
        alertEmail = await getSellerNotificationEmail(sellerPubkey);
      }

      if (!alertEmail) {
        const { fromEmail } =
          await import("@/utils/email/sendgrid-client").then((m) =>
            m.getUncachableSendGridClient()
          );
        alertEmail = fromEmail;
      }

      if (alertEmail) {
        await sendTransferFailureAlert(alertEmail, {
          subscriptionId,
          invoiceId: invoice.id,
          failures: failedTransfers.map((f) => ({
            sellerPubkey: f.pubkey,
            amountCents: f.amountCents,
            error: f.error,
          })),
        });
      }
    } catch (emailErr) {
      console.error("Failed to send transfer failure alert email:", emailErr);
    }

    if (failedTransfers.length >= nonPlatformSplits.length) {
      throw new Error(
        `All seller transfers failed for subscription ${subscriptionId}`
      );
    }
  }
}
