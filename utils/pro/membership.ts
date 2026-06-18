// Server-side membership resolution and billing-state application. Wraps the
// DB layer (`utils/db/pro-membership`) with the pure resolver
// (`utils/pro/membership-status`) and the billing mappers.

import type Stripe from "stripe";
import {
  computeLapseTimeline,
  PRO_MANUAL_GRACE_DAYS,
  PRO_NEW_USER_TRIAL_DAYS,
  PRO_STRIPE_GRACE_DAYS,
  PRO_TRIAL_DAYS,
  addDays,
  addTerm,
  type MembershipView,
  type ProBillingHistoryItem,
  type ProTerm,
} from "@/utils/pro/constants";
import { isProEntitled, membershipView } from "@/utils/pro/membership-status";
import {
  applyProManualState,
  applyProStripeState,
  getProMembership,
  getProMembershipBySubscription,
  grantLifetimeMembership,
  grantProTrialIfMissing,
  revokeProMembership,
  listCustomStallPubkeys,
  listExistingStallPubkeys,
  listPaidProManualInvoices,
  listSettledManualInvoicesMissingCoverage,
  setProManualInvoiceCoverage,
  syncProStripeMeta,
  getProSetting,
  setProSetting,
  type ProManualInvoiceRow,
} from "@/utils/db/pro-membership";
import {
  getProStripe,
  listProStripeInvoices,
  mapStripeSubscription,
} from "@/utils/pro/stripe-pro";
import { withStripeRetry } from "@/utils/stripe/retry-service";
import { getSellerNotificationEmail } from "@/utils/db/db-service";
import {
  sendProReceipt,
  sendProLifetimeLingeringCancelAlert,
} from "@/utils/email/email-service";
import { sendServerSideNostrDM } from "@/utils/nostr/server-nostr-helpers";
import { isSelfHostTenant } from "@/utils/self-host/config";

/**
 * Emit a structured, greppable log event for every attempt to cancel a lingering
 * recurring (Herd) subscription that a lifetime (Wrangler) member still holds.
 *
 * Operators watch the `failure` outcome to catch a subscription that refuses to
 * cancel — left stuck, the seller is charged for one more cycle before the next
 * webhook auto-retry (or never, if it's truly wedged). A `failure` also fires an
 * admin alert email (`alertLifetimeLingeringCancelFailure`) so operators don't
 * have to be actively watching logs. `source` separates the
 * at-purchase cancellation (`purchase`) from the renewal-webhook auto-retry
 * (`renewal_webhook`). All three outcomes share the
 * `pro_lifetime_lingering_subscription_cancel` event name and a
 * `[pro_lifetime_lingering_subscription_cancel]` tag so logs are filterable; the
 * `pubkey` + `subscriptionId` fields tell an operator exactly what to cancel by
 * hand. See docs/architecture/payments.md → Stripe Connect runbook.
 */
type LingeringCancelOutcome = "attempt" | "success" | "failure";

function logLifetimeLingeringCancel(
  outcome: LingeringCancelOutcome,
  fields: {
    pubkey: string;
    subscriptionId: string;
    source: "purchase" | "renewal_webhook";
    error?: unknown;
  }
): void {
  const payload = {
    event: "pro_lifetime_lingering_subscription_cancel",
    outcome,
    source: fields.source,
    pubkey: fields.pubkey,
    subscriptionId: fields.subscriptionId,
    ...(fields.error !== undefined
      ? {
          error:
            fields.error instanceof Error
              ? fields.error.message
              : String(fields.error),
        }
      : {}),
  };
  const tag = "[pro_lifetime_lingering_subscription_cancel]";
  if (outcome === "failure") {
    console.error(tag, JSON.stringify(payload), fields.error);
  } else {
    console.warn(tag, JSON.stringify(payload));
  }
}

// Once a stuck subscription has alerted the operator, suppress further alerts
// for the same subscription for this long. A truly wedged subscription would
// otherwise fire a fresh alert on every renewal-webhook auto-retry; the
// structured logs still record every attempt for anyone watching.
const LINGERING_CANCEL_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function lingeringCancelAlertDedupKey(subscriptionId: string): string {
  return `lifetime_lingering_cancel_alert:${subscriptionId}`;
}

/**
 * Email the operator when a lingering-subscription cancel fails so they can
 * cancel it by hand before the seller is charged again — mirroring how transfer
 * failures already alert admin. Deduped per subscription via `pro_settings`: the
 * dedup timestamp is only written after a mail actually goes out, so a transient
 * mail failure still re-alerts on the next webhook retry, while a single stuck
 * subscription can't spam an alert on every renewal. Best-effort: never throws,
 * so it can't fail the webhook or block the (already best-effort) cancel path.
 */
async function alertLifetimeLingeringCancelFailure(fields: {
  pubkey: string;
  subscriptionId: string;
  source: "purchase" | "renewal_webhook";
  error: unknown;
}): Promise<void> {
  try {
    const dedupKey = lingeringCancelAlertDedupKey(fields.subscriptionId);
    const last = await getProSetting(dedupKey);
    if (last) {
      const lastMs = new Date(last).getTime();
      if (
        Number.isFinite(lastMs) &&
        Date.now() - lastMs < LINGERING_CANCEL_ALERT_COOLDOWN_MS
      ) {
        return;
      }
    }

    const sent = await sendProLifetimeLingeringCancelAlert({
      pubkey: fields.pubkey,
      subscriptionId: fields.subscriptionId,
      source: fields.source,
      error:
        fields.error instanceof Error
          ? fields.error.message
          : String(fields.error),
    });

    if (sent) {
      await setProSetting(dedupKey, new Date().toISOString());
    }
  } catch (err) {
    console.error("alertLifetimeLingeringCancelFailure failed:", err);
  }
}

export async function getMembershipView(
  pubkey: string
): Promise<MembershipView> {
  // Self-host (single-tenant) bypass: on a seller's own private instance the
  // one configured owner pubkey is always a lifetime (Wrangler) member, so every
  // Pro/Herd feature unlocks without any billing row or Stripe involvement. This
  // is scoped to exactly that pubkey by isSelfHostTenant, which fails closed (no
  // tenant configured ⇒ no bypass) — every OTHER pubkey, and the entire normal
  // hosted platform (self-host off), is still resolved from the DB below. We
  // build a synthetic lifetime row so resolveMembershipStatus returns "active".
  if (isSelfHostTenant(pubkey)) {
    return membershipView(pubkey, {
      pubkey,
      lifetime: true,
      billing_method: "manual",
      term: null,
      status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      trial_end: null,
      current_period_end: null,
      grace_until: null,
      readonly_until: null,
      cancel_at_period_end: false,
    });
  }
  const row = await getProMembership(pubkey);
  return membershipView(pubkey, row);
}

// Inherits the self-host tenant bypass transitively via getMembershipView, so
// the owner is entitled on their own instance while everyone else resolves
// normally.
export async function isPubkeyProEntitled(pubkey: string): Promise<boolean> {
  const view = await getMembershipView(pubkey);
  return isProEntitled(view.status);
}

/**
 * Start a 30-day no-payment Pro trial for a new seller. The seller picks a plan
 * (monthly/yearly) up front so we know what to charge at trial end, but no
 * payment is collected now. The trial carries the same lapse timeline as a
 * lapsed paid plan (grace → read-only → hidden), so the existing lifecycle cron
 * naturally reminds them to pay once the trial ends.
 *
 * Idempotent and one-time per seller: backed by `grantProTrialIfMissing`'s
 * ON CONFLICT DO NOTHING, so it never resets an existing trial, a 90-day
 * grandfathered trial, or an active/lapsed paid membership. Returns whether a
 * fresh trial row was created plus the resolved membership view either way.
 */
export async function startNewUserProTrial(
  pubkey: string,
  term: ProTerm
): Promise<{ created: boolean; view: MembershipView }> {
  const trialEnd = addDays(new Date(), PRO_NEW_USER_TRIAL_DAYS);
  const { graceUntil, readonlyUntil } = computeLapseTimeline(
    trialEnd,
    PRO_MANUAL_GRACE_DAYS
  );
  const created = await grantProTrialIfMissing({
    pubkey,
    term,
    trialEnd,
    graceUntil,
    readonlyUntil,
  });
  const view = await getMembershipView(pubkey);
  return { created, view };
}

/**
 * Apply a Stripe subscription's current state to the membership.
 *
 * We only push the entitlement timeline forward when the subscription is
 * active/trialing with a future period end (i.e. genuinely paid). Incomplete,
 * canceled, past-due and unpaid states only sync metadata so we never grant
 * access prematurely or revoke it early — canceled subs lapse naturally once
 * their already-stored period end passes.
 */
export async function applyStripeSubscriptionToMembership(
  sub: Stripe.Subscription
): Promise<void> {
  const mapped = mapStripeSubscription(sub);

  let pubkey = mapped.pubkey;
  if (!pubkey) {
    const existing = await getProMembershipBySubscription(
      mapped.subscriptionId
    );
    pubkey = existing?.pubkey ?? null;
  }
  if (!pubkey) {
    console.warn(
      "applyStripeSubscriptionToMembership: no pubkey for subscription",
      mapped.subscriptionId
    );
    return;
  }

  // A lifetime (Wrangler) member must never be downgraded by a recurring
  // subscription webhook, and must never keep paying for one. If a lifetime
  // member still has a live subscription (e.g. an at-purchase cancellation
  // failed), cancel it now — this makes the renewal webhook itself an automatic
  // retry path — and skip applying any subscription state so the lifetime row
  // (status/term/timeline) is never clobbered. `lifetime` is sticky: only the
  // lifetime grant sets it, so this guard stays correct across webhook orderings.
  const current = await getProMembership(pubkey);
  if (current?.lifetime) {
    const stillLive =
      mapped.baseStatus !== "canceled" &&
      mapped.baseStatus !== "incomplete_expired";
    if (stillLive) {
      logLifetimeLingeringCancel("attempt", {
        pubkey,
        subscriptionId: mapped.subscriptionId,
        source: "renewal_webhook",
      });
      try {
        await withStripeRetry(() =>
          getProStripe().subscriptions.cancel(mapped.subscriptionId)
        );
        logLifetimeLingeringCancel("success", {
          pubkey,
          subscriptionId: mapped.subscriptionId,
          source: "renewal_webhook",
        });
      } catch (err) {
        logLifetimeLingeringCancel("failure", {
          pubkey,
          subscriptionId: mapped.subscriptionId,
          source: "renewal_webhook",
          error: err,
        });
        await alertLifetimeLingeringCancelFailure({
          pubkey,
          subscriptionId: mapped.subscriptionId,
          source: "renewal_webhook",
          error: err,
        });
      }
    }
    return;
  }

  // Admin-revoke guard: a subscription an admin revoked is permanently denied —
  // its stale/in-flight or later-retried webhooks must never re-grant or
  // re-link state. A genuine later re-subscribe uses a NEW subscription id (not
  // on the deny-list), so this never blocks legitimate resubscription.
  try {
    const denied = await getProSetting(
      adminRevokedSubscriptionKey(mapped.subscriptionId)
    );
    if (denied) return;
  } catch (err) {
    console.error(
      "applyStripeSubscriptionToMembership: admin-revoke guard check failed",
      err
    );
  }

  const grant =
    (mapped.baseStatus === "active" || mapped.baseStatus === "trialing") &&
    mapped.periodEnd !== null &&
    mapped.periodEnd.getTime() > Date.now();

  if (grant && mapped.periodEnd) {
    const { graceUntil, readonlyUntil } = computeLapseTimeline(
      mapped.periodEnd,
      PRO_STRIPE_GRACE_DAYS
    );
    await applyProStripeState({
      pubkey,
      customerId: mapped.customerId,
      subscriptionId: mapped.subscriptionId,
      baseStatus: mapped.baseStatus,
      term: mapped.term,
      currentPeriodEnd: mapped.periodEnd,
      graceUntil,
      readonlyUntil,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
    });
  } else {
    await syncProStripeMeta({
      pubkey,
      customerId: mapped.customerId,
      subscriptionId: mapped.subscriptionId,
      baseStatus: mapped.baseStatus,
      term: mapped.term,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
    });
  }
}

/**
 * Cancel a seller's live recurring Herd subscription, if any, when they switch
 * to lifetime (Wrangler) access — so they're never charged again. Cancels
 * immediately (not at period end) since lifetime already covers them forever.
 * Best-effort: a Stripe failure here must not block the lifetime grant. The
 * lifetime grant clears `stripe_subscription_id` in the DB regardless, so this
 * only stops the live recurring charge at Stripe. Read the membership BEFORE
 * the grant to capture the id (the grant nulls it), then cancel.
 */
export async function cancelExistingProSubscription(
  pubkey: string
): Promise<void> {
  let existing;
  try {
    existing = await getProMembership(pubkey);
  } catch (err) {
    console.error(
      "cancelExistingProSubscription: membership lookup failed",
      err
    );
    return;
  }

  const subscriptionId = existing?.stripe_subscription_id;
  if (!subscriptionId) return;

  logLifetimeLingeringCancel("attempt", {
    pubkey,
    subscriptionId,
    source: "purchase",
  });
  try {
    await withStripeRetry(() =>
      getProStripe().subscriptions.cancel(subscriptionId as string)
    );
    logLifetimeLingeringCancel("success", {
      pubkey,
      subscriptionId,
      source: "purchase",
    });
  } catch (err) {
    logLifetimeLingeringCancel("failure", {
      pubkey,
      subscriptionId,
      source: "purchase",
      error: err,
    });
    await alertLifetimeLingeringCancelFailure({
      pubkey,
      subscriptionId,
      source: "purchase",
      error: err,
    });
  }
}

/**
 * Admin: manually grant a seller timed Pro (Herd) access for `months` months.
 * Writes a manual-billing membership whose entitlement ends `months` out, with
 * the normal grace → read-only → hidden lapse timeline appended after, so an
 * admin-granted term lapses exactly like a paid manual term once it elapses.
 * `applyProManualState` clears the lifetime flag, so this also downgrades a
 * former Wrangler (lifetime) member to a fixed term. No invoice/receipt is
 * created — this is an operator action, not a purchase.
 */
export async function adminGrantProMembership(
  pubkey: string,
  months: number
): Promise<{ currentPeriodEnd: Date }> {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error("months must be an integer between 1 and 120");
  }
  const now = new Date();
  const currentPeriodEnd = new Date(now.getTime());
  currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + months);
  const { graceUntil, readonlyUntil } = computeLapseTimeline(
    currentPeriodEnd,
    PRO_MANUAL_GRACE_DAYS
  );
  const term: ProTerm = months >= 12 ? "yearly" : "monthly";
  await applyProManualState({
    pubkey,
    term,
    currentPeriodEnd,
    graceUntil,
    readonlyUntil,
  });
  return { currentPeriodEnd };
}

/**
 * Admin: manually grant a seller Wrangler lifetime access. Cancels any live
 * recurring Herd subscription at Stripe first (best-effort) so they're never
 * charged again, then writes the never-expiring lifetime grant.
 */
export async function adminGrantLifetimeMembership(
  pubkey: string
): Promise<void> {
  await cancelExistingProSubscription(pubkey);
  await grantLifetimeMembership({ pubkey, billingMethod: "manual" });
}

// pro_settings deny-key for a Stripe subscription id that an admin revoke
// cancelled. Stale, in-flight, or later-retried webhooks for that exact
// subscription must NEVER re-grant or re-link state (cancelling at Stripe and
// nulling the local id isn't enough — the webhook still resolves the pubkey
// from subscription metadata). Keyed by subscription id and never cleared: a
// genuine re-subscribe uses a NEW id that isn't on the list, so legitimate
// resubscription is never blocked.
function adminRevokedSubscriptionKey(subscriptionId: string): string {
  return `admin_revoked_subscription:${subscriptionId}`;
}

/**
 * Admin: revoke a seller's membership entirely, downgrading them to the free
 * tier. Records the live Stripe subscription id on a permanent deny-list FIRST
 * (so stale/retried webhooks for it can't resurrect access), then cancels that
 * subscription at Stripe (best-effort) and clears the local row's lifetime flag
 * and lapse timeline. The deny-list write happens before any state is cleared,
 * so if it (or the lookup) fails the whole revoke aborts and the membership is
 * left intact for the admin to retry — the revoke is never half-applied.
 */
export async function adminRevokeMembership(pubkey: string): Promise<void> {
  const existing = await getProMembership(pubkey);
  const subscriptionId = existing?.stripe_subscription_id ?? null;
  if (subscriptionId) {
    await setProSetting(adminRevokedSubscriptionKey(subscriptionId), "1");
  }
  await cancelExistingProSubscription(pubkey);
  await revokeProMembership(pubkey);
}

/**
 * Apply a settled one-time Wrangler lifetime PaymentIntent: grant the seller
 * permanent (never-expiring) access and send the receipt over email + Nostr.
 * Idempotent at the DB level (the lifetime upsert is keyed on pubkey), so
 * Stripe webhook retries can't double-grant or corrupt state. Best-effort on
 * the receipt — a mail/DM failure never throws out of the webhook handler.
 */
export async function applyStripeLifetimePayment(
  pi: Stripe.PaymentIntent
): Promise<void> {
  const pubkey = pi.metadata?.mmProPubkey;
  if (!pubkey) {
    console.warn("applyStripeLifetimePayment: no mmProPubkey on PaymentIntent");
    return;
  }
  const customerId =
    typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null);

  // If the buyer already had a recurring Herd subscription, cancel it now so
  // they're never charged again after buying lifetime access.
  await cancelExistingProSubscription(pubkey);

  await grantLifetimeMembership({
    pubkey,
    billingMethod: "stripe",
    customerId,
  });

  const details: ProReceiptDetails = {
    amountCents: pi.amount_received || pi.amount || 0,
    currency: pi.currency || "usd",
    term: null,
    method: "stripe",
    paidAt: pi.created ? new Date(pi.created * 1000).toISOString() : null,
    receiptUrl: null,
    lifetime: true,
  };

  try {
    const email = await getSellerNotificationEmail(pubkey);
    if (email) {
      await sendProReceipt(email, { ...details, invoicePdfUrl: null });
    }
  } catch (err) {
    console.error("applyStripeLifetimePayment: receipt email failed", err);
  }

  await sendProReceiptNostrDM(pubkey, details);
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isFinite(ms) ? d.toISOString() : null;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Reconstruct the coverage window each settled manual invoice paid for.
 *
 * Manual extensions stack from GREATEST(now, current_period_end, trial_end) at
 * settle time (see `MANUAL_EXTEND_SQL`), so an early renewal extends the prior
 * term rather than restarting "now". We don't persist the resulting window, so
 * we replay the same stacking here in paid order: each invoice's coverage
 * starts at the max of its paid time, the running period end so far, and the
 * trial end, and runs one term forward. Returns a map keyed by invoice_id.
 */
function computeManualCoverage(
  manual: ProManualInvoiceRow[],
  trialEnd: Date | null
): Map<string, { start: Date; end: Date }> {
  // Replay oldest-first so each renewal stacks on the prior period end. Tie-
  // break on created_at then id for a stable order when paid_at matches.
  const sorted = [...manual].sort((a, b) => {
    const at = (toDate(a.paid_at) ?? toDate(a.created_at))?.getTime() ?? 0;
    const bt = (toDate(b.paid_at) ?? toDate(b.created_at))?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    const ac = toDate(a.created_at)?.getTime() ?? 0;
    const bc = toDate(b.created_at)?.getTime() ?? 0;
    if (ac !== bc) return ac - bc;
    return a.id - b.id;
  });

  const trialMs = trialEnd ? trialEnd.getTime() : null;
  const coverage = new Map<string, { start: Date; end: Date }>();
  let runningEnd: Date | null = null;

  for (const inv of sorted) {
    // Lifetime (Wrangler) invoices have no term to stack and never expire, so
    // they contribute no coverage window to the renewal timeline.
    if (inv.lifetime || !inv.term) continue;
    const paidAt = toDate(inv.paid_at) ?? toDate(inv.created_at);
    if (!paidAt) continue;
    let baseMs = paidAt.getTime();
    if (runningEnd) baseMs = Math.max(baseMs, runningEnd.getTime());
    if (trialMs !== null) baseMs = Math.max(baseMs, trialMs);
    const start = new Date(baseMs);
    const end = addTerm(start, inv.term);
    coverage.set(inv.invoice_id, { start, end });
    runningEnd = end;
  }

  return coverage;
}

interface ProReceiptDetails {
  amountCents: number;
  currency: string;
  term: "monthly" | "yearly" | null;
  method: "stripe" | "bitcoin" | "fiat";
  paidAt: string | null;
  receiptUrl?: string | null;
  // One-time Wrangler lifetime purchase (no recurring term).
  lifetime?: boolean;
}

function formatReceiptAmount(amountCents: number, currency: string): string {
  const c = currency.toUpperCase();
  const major = (amountCents / 100).toFixed(2);
  return c === "USD" ? `$${major}` : `${major} ${c}`;
}

function formatReceiptDate(paidAt: string | null): string {
  if (!paidAt) return "";
  const d = new Date(paidAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * DM a seller a receipt summary for a just-paid Pro charge over Nostr, mirroring
 * the email + DM pattern used by the Pro lifecycle reminders. Best-effort: never
 * throws, so a relay/DM failure can't roll back the settle or fail the webhook.
 * This complements the email receipt so Nostr-first sellers with no notification
 * email on file still get confirmation.
 */
async function sendProReceiptNostrDM(
  pubkey: string,
  details: ProReceiptDetails
): Promise<void> {
  try {
    const amount = formatReceiptAmount(details.amountCents, details.currency);
    const date = formatReceiptDate(details.paidAt);
    const planLabel = details.lifetime
      ? "Wrangler (Lifetime)"
      : details.term === "yearly"
        ? "Herd (Annual)"
        : details.term === "monthly"
          ? "Herd (Monthly)"
          : null;
    const methodLabel =
      details.method === "stripe"
        ? "Card (Stripe)"
        : details.method === "bitcoin"
          ? "Bitcoin"
          : "Fiat";

    const activeLine = details.lifetime
      ? `We received your Milk Market payment of ${amount}. Your Wrangler lifetime access is active and never expires — here are the details for your records:`
      : `We received your Milk Market payment of ${amount}. Your Herd features stay active — here are the details for your records:`;
    const lines: string[] = [activeLine, ""];
    if (date) lines.push(`Date: ${date}`);
    lines.push(`Amount: ${amount}`);
    if (planLabel) lines.push(`Plan: ${planLabel}`);
    lines.push(`Payment method: ${methodLabel}`);
    if (details.receiptUrl) {
      lines.push("");
      lines.push(`Receipt: ${details.receiptUrl}`);
    }
    lines.push("");
    lines.push(
      "You can review your full billing history anytime from your account settings."
    );

    await sendServerSideNostrDM(
      pubkey,
      lines.join("\n"),
      `Milk Market — payment receipt (${amount})`
    );
  } catch (err) {
    console.error("sendProReceiptNostrDM failed:", err);
  }
}

/**
 * Notify a seller of a just-settled manual (Bitcoin/fiat) Pro invoice via both
 * an emailed receipt and a server-side Nostr DM. Best-effort: never throws, so a
 * mail/DM failure can't roll back the settle. Call only on a fresh "settled"
 * outcome to avoid duplicate receipts. (Name kept for historical call sites; now
 * sends over both channels like the Pro lifecycle reminders.)
 */
export async function sendProManualReceiptEmail(
  invoice: ProManualInvoiceRow
): Promise<void> {
  // The settle just happened; the pre-update row's paid_at may still be null, so
  // fall back to now rather than the (older) created_at.
  const paidAt = toIso(invoice.paid_at) ?? new Date().toISOString();
  const details: ProReceiptDetails = {
    amountCents: invoice.amount_usd_cents,
    currency: "usd",
    term: invoice.term,
    method: invoice.method,
    paidAt,
    receiptUrl: null,
    lifetime: invoice.lifetime,
  };

  try {
    const email = await getSellerNotificationEmail(invoice.pubkey);
    if (email) {
      await sendProReceipt(email, { ...details, invoicePdfUrl: null });
    }
  } catch (err) {
    console.error("sendProManualReceiptEmail failed:", err);
  }

  await sendProReceiptNostrDM(invoice.pubkey, details);
}

/**
 * Notify a seller of a paid Stripe Pro invoice (renewal or initial charge) via
 * both an emailed receipt and a server-side Nostr DM. Resolves the pubkey from
 * the subscription's membership row, the term from the invoice line item, and
 * includes Stripe's hosted receipt + PDF links. Best-effort: never throws, so a
 * mail/DM failure can't fail the webhook. Skips zero-amount invoices (e.g. $0
 * trial invoices) since there's nothing to receipt. (Name kept for historical
 * call sites; now sends over both channels like the Pro lifecycle reminders.)
 */
export async function sendProStripeReceiptEmail(
  invoice: Stripe.Invoice
): Promise<void> {
  const amountCents = invoice.amount_paid ?? 0;
  if (amountCents <= 0) return;

  const subscriptionId =
    typeof (invoice as any).subscription === "string"
      ? (invoice as any).subscription
      : (invoice as any).subscription?.id;
  if (!subscriptionId) return;

  let pubkey: string | null = null;
  try {
    const membership = await getProMembershipBySubscription(subscriptionId);
    pubkey = membership?.pubkey ?? null;
  } catch (err) {
    console.error("sendProStripeReceiptEmail: membership lookup failed", err);
  }
  if (!pubkey) return;

  const line = invoice.lines?.data?.[0] as any;
  const interval =
    line?.price?.recurring?.interval ??
    line?.plan?.interval ??
    line?.pricing?.price_details?.recurring?.interval ??
    null;
  const term: "monthly" | "yearly" | null =
    interval === "year" ? "yearly" : interval === "month" ? "monthly" : null;

  const paidUnix =
    (invoice.status_transitions && invoice.status_transitions.paid_at) ||
    invoice.created;
  const paidAt =
    typeof paidUnix === "number"
      ? new Date(paidUnix * 1000).toISOString()
      : null;

  const details: ProReceiptDetails = {
    amountCents,
    currency: invoice.currency,
    term,
    method: "stripe",
    paidAt,
    receiptUrl: invoice.hosted_invoice_url ?? null,
  };

  try {
    const email = await getSellerNotificationEmail(pubkey);
    if (email) {
      await sendProReceipt(email, {
        ...details,
        invoicePdfUrl: invoice.invoice_pdf ?? null,
      });
    }
  } catch (err) {
    console.error("sendProStripeReceiptEmail failed:", err);
  }

  await sendProReceiptNostrDM(pubkey, details);
}

/**
 * Unified billing history for a seller: settled manual (Bitcoin/fiat) invoices
 * from our DB plus paid Stripe invoices pulled live from Stripe, merged and
 * sorted newest-first. Stripe entries carry receipt/PDF links. If Stripe is
 * unreachable we still return the manual history rather than failing the view.
 */
export async function getProBillingHistory(
  pubkey: string
): Promise<ProBillingHistoryItem[]> {
  const [membership, manual] = await Promise.all([
    getProMembership(pubkey),
    listPaidProManualInvoices(pubkey),
  ]);

  const manualCoverage = computeManualCoverage(
    manual,
    toDate(membership?.trial_end)
  );

  const items: ProBillingHistoryItem[] = manual.map((inv) => {
    // Prefer the exact window persisted at settle time. Invoices settled before
    // that was stored fall back to the replayed stacking reconstruction.
    const cov = manualCoverage.get(inv.invoice_id);
    const storedStart = toIso(inv.coverage_start);
    const storedEnd = toIso(inv.coverage_end);
    return {
      id: inv.invoice_id,
      source: "manual",
      paidAt: toIso(inv.paid_at) ?? toIso(inv.created_at),
      amountCents: inv.amount_usd_cents,
      currency: "usd",
      term: inv.term,
      lifetime: inv.lifetime,
      method: inv.method,
      coverageStart: storedStart ?? (cov ? cov.start.toISOString() : null),
      coverageEnd: storedEnd ?? (cov ? cov.end.toISOString() : null),
      receiptUrl: null,
      invoicePdfUrl: null,
    };
  });

  if (membership?.stripe_customer_id) {
    try {
      const stripeInvoices = await listProStripeInvoices(
        membership.stripe_customer_id
      );
      for (const inv of stripeInvoices) {
        items.push({
          id: inv.id,
          source: "stripe",
          paidAt: toIso(inv.paidAt),
          amountCents: inv.amountCents,
          currency: inv.currency,
          term: inv.term,
          method: "stripe",
          coverageStart: toIso(inv.coverageStart),
          coverageEnd: toIso(inv.coverageEnd),
          receiptUrl: inv.receiptUrl,
          invoicePdfUrl: inv.invoicePdfUrl,
        });
      }
    } catch (error) {
      console.error("getProBillingHistory: stripe invoice list failed", error);
    }
  }

  items.sort((a, b) => {
    const at = a.paidAt ? new Date(a.paidAt).getTime() : 0;
    const bt = b.paidAt ? new Date(b.paidAt).getTime() : 0;
    return bt - at;
  });

  return items;
}

const TRIAL_BACKFILL_FLAG = "trial_backfill_v1";

/**
 * One-time grandfathering: grant every existing stall a 3-month trial. Guarded
 * by a flag in `pro_settings` so it runs exactly once; new sellers created
 * afterwards default to Free.
 */
export async function backfillProTrialsOnce(): Promise<{
  ran: boolean;
  granted: number;
}> {
  const done = await getProSetting(TRIAL_BACKFILL_FLAG);
  if (done) return { ran: false, granted: 0 };

  const pubkeys = await listExistingStallPubkeys();
  const now = new Date();
  const trialEnd = addDays(now, PRO_TRIAL_DAYS);
  const { graceUntil, readonlyUntil } = computeLapseTimeline(
    trialEnd,
    PRO_MANUAL_GRACE_DAYS
  );

  let granted = 0;
  for (const pubkey of pubkeys) {
    const created = await grantProTrialIfMissing({
      pubkey,
      trialEnd,
      graceUntil,
      readonlyUntil,
    });
    if (created) granted += 1;
  }

  await setProSetting(TRIAL_BACKFILL_FLAG, now.toISOString());
  return { ran: true, granted };
}

const COVERAGE_BACKFILL_FLAG = "manual_coverage_backfill_v1";

/**
 * One-time backfill of coverage_start/end for manual invoices that were settled
 * before those columns were stamped. For each affected seller we replay the same
 * stacking reconstruction the billing history uses (`computeManualCoverage`) over
 * ALL their paid invoices, then persist the window onto the ones still missing
 * it. Idempotent: only NULL windows are written, and a one-shot flag short-
 * circuits subsequent runs so the cron can call it every tick cheaply.
 */
export async function backfillManualCoverageOnce(): Promise<{
  ran: boolean;
  filled: number;
}> {
  const done = await getProSetting(COVERAGE_BACKFILL_FLAG);
  if (done) return { ran: false, filled: 0 };

  const missing = await listSettledManualInvoicesMissingCoverage();
  const pubkeys = Array.from(new Set(missing.map((inv) => inv.pubkey)));

  let filled = 0;
  for (const pubkey of pubkeys) {
    const [row, paid] = await Promise.all([
      getProMembership(pubkey),
      listPaidProManualInvoices(pubkey),
    ]);
    const trialEnd = toDate(row?.trial_end ?? null);
    const coverage = computeManualCoverage(paid, trialEnd);

    for (const inv of missing) {
      if (inv.pubkey !== pubkey) continue;
      const cov = coverage.get(inv.invoice_id);
      if (!cov) continue;
      await setProManualInvoiceCoverage(inv.invoice_id, cov.start, cov.end);
      filled += 1;
    }
  }

  await setProSetting(COVERAGE_BACKFILL_FLAG, new Date().toISOString());
  return { ran: true, filled };
}

const CUSTOM_STALL_LIFETIME_FLAG = "custom_stall_lifetime_grandfather_v1";

/**
 * One-time grandfather of existing custom-stall sellers into a free, never-
 * expiring lifetime (Wrangler) membership — instead of the standard recurring
 * membership. Target population is the narrower "custom stall" set: sellers who
 * claimed a custom storefront URL slug or a custom domain
 * (`listCustomStallPubkeys`).
 *
 * Runs automatically on the next lifecycle cron tick after deploy and never
 * again: a one-shot `pro_settings` flag short-circuits subsequent runs (same
 * pattern as `backfillProTrialsOnce`). The same logic is exposed as an operator
 * CLI (`scripts/grandfather-custom-stall-lifetime.ts`) for manual/dry runs.
 *
 * Idempotent: already-lifetime sellers are skipped, and `grantLifetimeMembership`
 * upserts on pubkey. For each non-lifetime seller it cancels any live recurring
 * Stripe subscription first (so they're never charged again — the grant only
 * nulls the local sub id, it doesn't stop the live Stripe charge), then grants
 * lifetime with `billing_method = 'manual'` (a free grant, not a paid sale).
 */
export async function grandfatherCustomStallLifetimeOnce(): Promise<{
  ran: boolean;
  granted: number;
}> {
  const done = await getProSetting(CUSTOM_STALL_LIFETIME_FLAG);
  if (done) return { ran: false, granted: 0 };

  const pubkeys = await listCustomStallPubkeys();

  let granted = 0;
  for (const pubkey of pubkeys) {
    const existing = await getProMembership(pubkey);
    if (existing?.lifetime) continue;
    // Stop any live recurring charge first (best-effort), then grant lifetime.
    await cancelExistingProSubscription(pubkey);
    await grantLifetimeMembership({ pubkey, billingMethod: "manual" });
    granted += 1;
  }

  await setProSetting(CUSTOM_STALL_LIFETIME_FLAG, new Date().toISOString());
  return { ran: true, granted };
}
