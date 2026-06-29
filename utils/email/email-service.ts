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
 * reputation and spoof "from Milk Market". So a sender rejection here counts as
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
  const { to, subject, html, fromEmail, fromName, replyTo, headers } = params;
  if (!fromEmail || !fromEmail.includes("@")) {
    console.error("sendEmailStrictFrom called without a valid from-address");
    return false;
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
    await client.send(msg);
    return true;
  } catch (error) {
    console.error("sendEmailStrictFrom: send failed (no fallback):", error);
    return false;
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

export async function sendTransferFailureAlert(
  adminEmail: string,
  params: {
    subscriptionId: string;
    invoiceId: string;
    failures: Array<{
      sellerPubkey: string;
      amountCents: number;
      error: string;
    }>;
  }
): Promise<boolean> {
  const { subject, html } = transferFailureAlertEmail(params);
  return sendEmail(adminEmail, subject, html);
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
  let recipient = (params.adminEmail || "").trim();
  try {
    if (!recipient) {
      const { fromEmail } = await getUncachableSendGridClient();
      recipient = (fromEmail || "").trim();
    }
  } catch (err) {
    console.error(
      "[pro_lifetime_lingering_subscription_cancel] Failed to resolve admin email recipient:",
      err
    );
    return false;
  }
  if (!recipient) {
    console.error(
      "[pro_lifetime_lingering_subscription_cancel] No admin email recipient available (configure SendGrid from_email)"
    );
    return false;
  }
  return sendEmail(recipient, subject, html);
}
