import { getUncachableSendGridClient } from "./sendgrid-client";
import {
  orderConfirmationEmail,
  sellerNewOrderEmail,
  orderUpdateEmail,
  subscriptionConfirmationEmail,
  renewalReminderEmail,
  addressChangeConfirmationEmail,
  subscriptionCancellationEmail,
  returnRequestEmail,
  inquiryNotificationEmail,
  contactFormEmail,
  accountRecoveryEmail,
  paymentFailedBuyerEmail,
  paymentFailedSellerEmail,
  transferFailureAlertEmail,
  proLifetimeLingeringCancelAlertEmail,
  orphanedSubscriptionPaymentAlertEmail,
  orphanedSubscriptionCancellationAlertEmail,
  orphanedSubscriptionReminderAlertEmail,
  orphanedStripeEventAlertEmail,
  customDomainAdminNotificationEmail,
  affiliatePaidEmail,
  affiliatePausedToAffiliateEmail,
  affiliatePausedToSellerEmail,
  proReceiptEmail,
  OrderEmailParams,
  SubscriptionEmailParams,
  StorefrontBranding,
} from "./email-templates";

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
  headers?: Record<string, string>,
  fromName?: string,
  fromEmail?: string
): Promise<boolean> {
  try {
    const { client, fromEmail: defaultFromEmail } =
      await getUncachableSendGridClient();
    // Sanitize the display name to keep SendGrid happy: strip control chars
    // and newlines, cap length. Fall back to bare email if nothing usable.
    const safeFromName = fromName
      ? fromName
          .replace(/[\r\n\t\u0000-\u001F]/g, " ")
          .slice(0, 78)
          .trim()
      : "";
    // A seller's custom from-address is only ever passed here once it has been
    // SendGrid-validated (see resolveSellerSenderEmail). We still guard the
    // send below so an unexpected rejection can never drop the email.
    const customFromEmail =
      fromEmail && fromEmail.includes("@") ? fromEmail : null;
    const senderEmail = customFromEmail || defaultFromEmail;

    const buildMsg = (sender: string) => {
      const msg: any = {
        to,
        from: safeFromName ? { email: sender, name: safeFromName } : sender,
        subject,
        html,
      };
      if (replyTo) {
        msg.replyTo = replyTo;
      }
      if (headers && Object.keys(headers).length > 0) {
        // SendGrid honors RFC headers passed via the `headers` field. Required
        // for List-Unsubscribe / RFC 8058 one-click compliance on Gmail/Yahoo.
        msg.headers = headers;
      }
      return msg;
    };

    try {
      await client.send(buildMsg(senderEmail));
      return true;
    } catch (sendError) {
      // Never let a seller's custom from-address break delivery: if SendGrid
      // rejects it as an unverified sender, retry once with the global sender.
      if (customFromEmail && isVerifiedSenderError(sendError)) {
        console.error(
          "Custom sender rejected by SendGrid; retrying with default sender:",
          customFromEmail
        );
        await client.send(buildMsg(defaultFromEmail));
        return true;
      }
      throw sendError;
    }
  } catch (error) {
    console.error("Failed to send email:", error);
    return false;
  }
}

/**
 * Strict-from send for SELLER BULK BROADCASTS (blog-post emails to a seller's
 * whole audience). Unlike `sendEmail`, this NEVER falls back to the platform's
 * global verified sender: a seller's marketing blast must originate only from
 * their own SendGrid domain-authenticated address. If we silently fell back to
 * the global sender, any Pro seller could blast a list under the platform's
 * reputation and spoof "from Self-sown". So a sender rejection here counts as
 * a failed send (return false), never a global-sent one. The caller is
 * responsible for proving the seller owns `fromEmail` (resolveSellerSenderEmail)
 * BEFORE calling this — there is no other safety net.
 */
export async function sendEmailStrictFrom(params: {
  to: string;
  subject: string;
  html: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}): Promise<boolean> {
  return (await sendEmailStrictFromDetailed(params)).ok;
}

export interface StrictFromSendResult {
  ok: boolean;
  /**
   * True only when SendGrid DEFINITELY rejected the message (HTTP 4xx other
   * than 408/429): nothing was accepted, so a retry can never duplicate it.
   * False for timeouts/network errors and 5xx, where acceptance is unknown.
   */
  definiteReject: boolean;
  /**
   * True only when the rejection is attributable to the RECIPIENT address
   * itself (HTTP 400 with an error on the to/personalizations field or a
   * suppression-list message): the address is provably dead and must never
   * be re-attempted. Deliberately narrower than definiteReject — account- or
   * sender-level 4xx (401/403 auth, 413 payload, ...) fail EVERY recipient
   * identically, so treating them as dead addresses would wipe a whole
   * audience when e.g. a seller's domain authentication lapses.
   */
  recipientReject: boolean;
}

/**
 * Whether a SendGrid rejection blames the recipient address: HTTP 400 whose
 * error entries either reference an explicit recipient `to` field (e.g.
 * "to", "to.0.email", "personalizations.0.to.0.email") or carry a
 * suppression-list message that unambiguously names the to/recipient
 * address. Everything else — non-`to` personalization fields (subject,
 * headers), from-address errors, auth, payload size — is NOT
 * recipient-attributable, because sender/content-level 400s fail EVERY
 * recipient identically and misclassifying one would durably suppress the
 * seller's entire audience.
 */
function isRecipientAddressRejection(status: number, error: any): boolean {
  if (status !== 400) return false;
  let body: any = error?.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
  return errors.some((entry) => {
    const field = typeof entry?.field === "string" ? entry.field : "";
    const message = typeof entry?.message === "string" ? entry.message : "";
    // Field must name a recipient `to` path segment — "personalizations"
    // alone also matches subject/headers/etc., and "from.email" wording can
    // carry address-validity messages that are NOT about the recipient.
    if (/(^|\.)to(\.|$)/i.test(field)) return true;
    // Message-only fallback: suppression-list errors that explicitly name
    // the to/recipient address ("The to address is on the suppression
    // list"). Bare "invalid email"/"valid address" wording is ambiguous —
    // SendGrid uses it for the FROM address too — so it is never enough.
    return /\b(to|recipient)\b[^.]*suppression list|suppression list[^.]*\b(to|recipient)\b/i.test(
      message
    );
  });
}

/**
 * Classify a thrown SendGrid send error the same way
 * sendEmailStrictFromDetailed does, for senders that manage their own
 * fallback logic (e.g. the drip-flow processor's custom-sender retry) and
 * therefore cannot use that helper directly. `recipientReject` = the
 * rejection blames the RECIPIENT address itself, so the address is provably
 * dead and must be durably suppressed instead of re-attempted.
 */
export function classifySendGridSendError(error: any): {
  definiteReject: boolean;
  recipientReject: boolean;
} {
  const status =
    error?.code ?? error?.response?.statusCode ?? error?.statusCode;
  const definiteReject =
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;
  const recipientReject =
    definiteReject && isRecipientAddressRejection(status, error);
  return { definiteReject, recipientReject };
}

/**
 * Detailed variant of sendEmailStrictFrom for at-most-once senders (e.g. the
 * one-time broadcast ledger): distinguishes a definite provider rejection
 * (safe to retry) from an ambiguous failure (must NOT be retried blindly).
 */
export async function sendEmailStrictFromDetailed(params: {
  to: string;
  subject: string;
  html: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /**
   * SendGrid custom args echoed back verbatim on every Event Webhook event
   * for this message. Broadcast senders stamp the owning seller's pubkey here
   * (see SELLER_PUBKEY_CUSTOM_ARG) so an asynchronous bounce/dropped/spamreport
   * can be attributed back to the seller's suppression list — SendGrid's
   * events carry no other link to the seller the blast was sent for.
   */
  customArgs?: Record<string, string>;
}): Promise<StrictFromSendResult> {
  const { to, subject, html, fromEmail, fromName, replyTo, headers, customArgs } =
    params;
  if (!fromEmail || !fromEmail.includes("@")) {
    console.error("sendEmailStrictFrom called without a valid from-address");
    return { ok: false, definiteReject: true, recipientReject: false };
  }
  try {
    const { client } = await getUncachableSendGridClient();
    const safeFromName = fromName
      ? fromName
          .replace(/[\r\n\t\u0000-\u001F]/g, " ")
          .slice(0, 78)
          .trim()
      : "";
    const msg: any = {
      to,
      from: safeFromName ? { email: fromEmail, name: safeFromName } : fromEmail,
      subject,
      html,
    };
    if (replyTo) msg.replyTo = replyTo;
    if (headers && Object.keys(headers).length > 0) msg.headers = headers;
    if (customArgs) {
      // SendGrid requires string keys/values; drop anything else rather than
      // failing the send over metadata.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(customArgs)) {
        if (typeof v === "string" && k && !clean[k]) clean[k] = v;
      }
      if (Object.keys(clean).length > 0) msg.customArgs = clean;
    }
    await client.send(msg);
    return { ok: true, definiteReject: false, recipientReject: false };
  } catch (error: any) {
    console.error("sendEmailStrictFrom: send failed (no fallback):", error);
    const { definiteReject, recipientReject } =
      classifySendGridSendError(error);
    return { ok: false, definiteReject, recipientReject };
  }
}

/**
 * Detect SendGrid "from address is not a verified sender / authenticated
 * domain" rejections (HTTP 403 + sender-identity message) so callers can fall
 * back to the platform's global verified sender instead of dropping the email.
 */
export function isVerifiedSenderError(error: any): boolean {
  const status =
    error?.code ?? error?.response?.statusCode ?? error?.statusCode;
  if (status === 403) return true;
  const body = error?.response?.body;
  const text =
    typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  return /verif|from address|sender identity|does not match/i.test(
    `${text} ${error?.message || ""}`
  );
}

export async function sendOrderConfirmationToBuyer(
  buyerEmail: string,
  params: OrderEmailParams,
  branding?: StorefrontBranding | null,
  replyTo?: string,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = orderConfirmationEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    replyTo,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendNewOrderToSeller(
  sellerEmail: string,
  params: OrderEmailParams,
  branding?: StorefrontBranding | null,
  replyTo?: string,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = sellerNewOrderEmail(params, branding);
  return sendEmail(
    sellerEmail,
    subject,
    html,
    replyTo,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendOrderUpdateToBuyer(
  buyerEmail: string,
  params: {
    orderId: string;
    productTitle: string;
    updateType: "shipping" | "status" | "message";
    message: string;
    trackingNumber?: string;
    carrier?: string;
    estimatedDelivery?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = orderUpdateEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendSubscriptionConfirmation(
  buyerEmail: string,
  params: SubscriptionEmailParams,
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = subscriptionConfirmationEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendRenewalReminder(
  buyerEmail: string,
  params: SubscriptionEmailParams,
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = renewalReminderEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendAddressChangeConfirmation(
  buyerEmail: string,
  params: {
    productTitle: string;
    newAddress: string;
    buyerName?: string;
    subscriptionId?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = addressChangeConfirmationEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendSubscriptionCancellation(
  buyerEmail: string,
  params: {
    productTitle: string;
    buyerName?: string;
    endDate: string;
    subscriptionId?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = subscriptionCancellationEmail(params, branding);
  return sendEmail(
    buyerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendInquiryNotification(
  recipientEmail: string,
  params: {
    senderName: string;
    message: string;
    senderHasEmail: boolean;
    senderEmail?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = inquiryNotificationEmail(
    {
      senderName: params.senderName,
      message: params.message,
      senderHasEmail: params.senderHasEmail,
    },
    branding
  );
  return sendEmail(
    recipientEmail,
    subject,
    html,
    params.senderEmail,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendContactFormNotification(
  recipientEmail: string,
  params: {
    name: string;
    email?: string;
    phone?: string;
    message?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = contactFormEmail(
    {
      name: params.name,
      email: params.email,
      phone: params.phone,
      message: params.message,
    },
    branding
  );
  return sendEmail(
    recipientEmail,
    subject,
    html,
    params.email,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendRecoveryEmail(
  recipientEmail: string,
  recoveryLink: string
): Promise<boolean> {
  const { subject, html } = accountRecoveryEmail({ recoveryLink });
  return sendEmail(recipientEmail, subject, html);
}

export async function sendReturnRequestToSeller(
  sellerEmail: string,
  params: {
    orderId: string;
    productTitle: string;
    requestType: "return" | "refund" | "exchange";
    message: string;
    buyerName?: string;
  },
  branding?: StorefrontBranding | null,
  fromEmail?: string
): Promise<boolean> {
  const { subject, html } = returnRequestEmail(params, branding);
  return sendEmail(
    sellerEmail,
    subject,
    html,
    undefined,
    undefined,
    branding?.shopName,
    fromEmail
  );
}

export async function sendPaymentFailedToBuyer(
  buyerEmail: string,
  params: {
    invoiceId: string;
    subscriptionId?: string;
    amountDisplay?: string;
  }
): Promise<boolean> {
  const { subject, html } = paymentFailedBuyerEmail(params);
  return sendEmail(buyerEmail, subject, html);
}

export async function sendPaymentFailedToSeller(
  sellerEmail: string,
  params: {
    invoiceId: string;
    subscriptionId?: string;
    customerEmail?: string;
    amountDisplay?: string;
  }
): Promise<boolean> {
  const { subject, html } = paymentFailedSellerEmail(params);
  return sendEmail(sellerEmail, subject, html);
}

export async function sendAffiliatePaidEmail(
  affiliateEmail: string,
  params: {
    affiliateName: string;
    amountSmallest: number;
    currency: string;
    method: "stripe" | "lightning" | "manual";
    externalRef?: string | null;
    unsubscribeUrl?: string | null;
  }
): Promise<boolean> {
  const { subject, html, headers } = affiliatePaidEmail(params);
  return sendEmail(affiliateEmail, subject, html, undefined, headers);
}

export async function sendAffiliatePausedToAffiliate(
  affiliateEmail: string,
  params: {
    affiliateName: string;
    reason: string;
    unsubscribeUrl?: string | null;
  }
): Promise<boolean> {
  const { subject, html, headers } = affiliatePausedToAffiliateEmail(params);
  return sendEmail(affiliateEmail, subject, html, undefined, headers);
}

export async function sendAffiliatePausedToSeller(
  sellerEmail: string,
  params: {
    affiliateName: string;
    reason: string;
    failureCount: number;
  }
): Promise<boolean> {
  const { subject, html } = affiliatePausedToSellerEmail(params);
  return sendEmail(sellerEmail, subject, html);
}

export async function sendCustomDomainAdminNotification(
  adminEmail: string | undefined,
  params: {
    domain: string;
    domainType: "subdomain" | "apex";
    shopSlug: string;
    sellerPubkey: string;
    verificationToken: string;
  }
): Promise<boolean> {
  const { subject, html } = customDomainAdminNotificationEmail(params);
  // Resolve recipient: explicit env > SendGrid verified from_email (which is
  // the operator's own mailbox by definition). This guarantees the notice
  // lands somewhere the operator actually owns even when DOMAINS_ADMIN_EMAIL
  // hasn't been configured.
  let recipient = (adminEmail || "").trim();
  try {
    if (!recipient) {
      const { fromEmail } = await getUncachableSendGridClient();
      recipient = (fromEmail || "").trim();
    }
  } catch (err) {
    console.error(
      "[custom-domain] Failed to resolve admin email recipient:",
      err
    );
    return false;
  }
  if (!recipient) {
    console.error(
      "[custom-domain] No admin email recipient available (set DOMAINS_ADMIN_EMAIL or configure SendGrid from_email)"
    );
    return false;
  }
  const ok = await sendEmail(recipient, subject, html);
  if (!ok) {
    console.error(
      `[custom-domain] sendEmail returned false for admin notification to ${recipient} (domain=${params.domain})`
    );
  } else {
    console.log(
      `[custom-domain] Sent admin notification to ${recipient} for domain ${params.domain}`
    );
  }
  return ok;
}

export async function sendProReceipt(
  sellerEmail: string,
  params: {
    amountCents: number;
    currency: string;
    term: "monthly" | "yearly" | null;
    method: "stripe" | "bitcoin" | "fiat";
    paidAt: string | null;
    receiptUrl?: string | null;
    invoicePdfUrl?: string | null;
    lifetime?: boolean;
  }
): Promise<boolean> {
  const { subject, html } = proReceiptEmail(params);
  return sendEmail(sellerEmail, subject, html);
}

export async function sendTransferFailureAlert(params: {
  subscriptionId: string;
  invoiceId: string;
  failures: Array<{
    sellerPubkey: string;
    amountCents: number;
    error: string;
  }>;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = transferFailureAlertEmail(params);
  // Ops alert: route to the shared ops recipient (explicit admin email, then
  // the verified platform sender) — never to a subscription seller. A seller
  // can't act on platform-side transfer remediation, and in a multi-seller
  // renewal the failure details cover OTHER sellers too.
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    "transfer_failure"
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}

/**
 * Shared recipient resolution for ops alerts: explicit adminEmail (trimmed)
 * wins, then the SendGrid verified from_email (the operator's own mailbox).
 * Returns null — after logging loudly under the alert's marker — when neither
 * is available or resolution fails, so every ops alert fails the same visible
 * way instead of silently returning false. Keep ALL ops-alert senders on this
 * helper: a fix applied to only one copy leaves the others stale.
 */
async function resolveOpsAlertRecipient(
  adminEmail: string | undefined,
  logMarker: string
): Promise<string | null> {
  let recipient = (adminEmail || "").trim();
  try {
    if (!recipient) {
      const { fromEmail } = await getUncachableSendGridClient();
      recipient = (fromEmail || "").trim();
    }
  } catch (err) {
    console.error(
      `[${logMarker}] Failed to resolve admin email recipient:`,
      err
    );
    return null;
  }
  if (!recipient) {
    console.error(
      `[${logMarker}] No admin email recipient available (set DOMAINS_ADMIN_EMAIL or configure SendGrid from_email)`
    );
    return null;
  }
  return recipient;
}

/**
 * Alert the operator that a lifetime (Wrangler) member's lingering recurring
 * subscription failed to cancel and is still charging the seller. Resolves the
 * recipient the same way the custom-domain admin notice does — explicit
 * adminEmail > SendGrid verified from_email (the operator's own mailbox) — so
 * the alert lands somewhere the operator owns even with no dedicated admin env.
 * Returns whether the email was actually sent so the caller can dedup correctly.
 */
export async function sendProLifetimeLingeringCancelAlert(params: {
  pubkey: string;
  subscriptionId: string;
  source: "purchase" | "renewal_webhook";
  error: string;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = proLifetimeLingeringCancelAlertEmail(params);
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    "pro_lifetime_lingering_subscription_cancel"
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}

/**
 * Alert the operator that a paid renewal invoice matched no local
 * subscriptions row (ORPHANED_SUBSCRIPTION_PAYMENT). Resolves the recipient
 * the same way the other ops alerts do — explicit adminEmail > SendGrid
 * verified from_email (the operator's own mailbox). Returns whether the email
 * was actually sent; callers must treat a false/throw as non-fatal because
 * the webhook response must stay 200 (the row will never appear on retry).
 */
export async function sendOrphanedSubscriptionPaymentAlert(params: {
  stripeSubscriptionId: string;
  invoiceId: string;
  eventId: string;
  amountPaid: string;
  currency: string;
  customerEmail: string;
  billingReason: string;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = orphanedSubscriptionPaymentAlertEmail(params);
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    "orphaned_subscription_payment"
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}

/**
 * Alert the operator that a customer.subscription.deleted event matched no
 * local subscriptions row (ORPHANED_SUBSCRIPTION_CANCEL). Resolves the
 * recipient the same way the other ops alerts do — explicit adminEmail >
 * SendGrid verified from_email. Returns whether the email was actually sent;
 * callers must treat a false/throw as non-fatal because the webhook response
 * must stay 200 (the row will never appear on retry).
 */
export async function sendOrphanedSubscriptionCancellationAlert(params: {
  stripeSubscriptionId: string;
  eventId: string;
  customer: string;
  status: string;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = orphanedSubscriptionCancellationAlertEmail(params);
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    "orphaned_subscription_cancel"
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}

/**
 * Alert the operator that an invoice.upcoming renewal reminder matched no
 * local subscriptions row (ORPHANED_SUBSCRIPTION_REMINDER) — a buyer is about
 * to be charged without ever being warned. Same recipient resolution as the
 * other ops alerts; returns whether the email was actually sent, and callers
 * must treat a false/throw as non-fatal because the webhook response must
 * stay 200 (the row will never appear on retry).
 */
export async function sendOrphanedSubscriptionReminderAlert(params: {
  stripeSubscriptionId: string;
  invoiceId: string;
  eventId: string;
  customerEmail: string;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = orphanedSubscriptionReminderAlertEmail(params);
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    "orphaned_subscription_reminder"
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}

/**
 * Generic ops alert for an ORPHANED_* Stripe event: money moved at Stripe but
 * no local record matched. One sender for every orphan marker so each alert
 * shares the same recipient resolution and template shape instead of growing
 * a parallel email path per marker. Returns whether the email was actually
 * sent; callers must treat a false/throw as non-fatal because the webhook
 * response must stay 200 (the row will never appear on retry).
 */
export async function sendOrphanedStripeEventAlert(params: {
  title: string;
  marker: string;
  logTag: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  adminEmail?: string;
}): Promise<boolean> {
  const { subject, html } = orphanedStripeEventAlertEmail(params);
  const recipient = await resolveOpsAlertRecipient(
    params.adminEmail,
    params.logTag
  );
  if (!recipient) return false;
  return sendEmail(recipient, subject, html);
}
