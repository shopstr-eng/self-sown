import { NextApiRequest, NextApiResponse } from "next";
import {
  sendSubscriptionConfirmation,
  sendRenewalReminder,
  sendAddressChangeConfirmation,
  sendSubscriptionCancellation,
} from "@/utils/email/email-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { getSubscriptionByStripeId } from "@/utils/db/db-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

const normalizeEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "email-send-subscription", RATE_LIMIT)))
    return;

  const { type, buyerEmail, sellerPubkey, ...params } = req.body;

  if (!type || !buyerEmail) {
    return res.status(400).json({ error: "type and buyerEmail are required" });
  }

  try {
    const branding = await loadStorefrontBranding(sellerPubkey);

    // Resolve the seller's custom DKIM-authenticated from-address ONLY when this
    // request is provably tied to a genuine subscription owned by that seller.
    // This endpoint is unauthenticated with buyer-initiated callers, and the
    // recipient is supplied in the request body — so we cannot trust the body
    // sellerPubkey/recipient alone. Subscriptions are server-authoritative
    // records (created by the verified Stripe flow), so we look the subscription
    // up by its Stripe id and require BOTH the seller pubkey AND the recipient
    // email to match the stored record. A forged sellerPubkey or an
    // attacker-chosen recipient fails this check and falls back to the global
    // verified sender, so a seller's domain can never be spoofed. Delivery is
    // unaffected either way (sendEmail also retries the global sender on a 403).
    let sellerFromEmail: string | undefined;
    try {
      const subscriptionId =
        typeof params.subscriptionId === "string" ? params.subscriptionId : "";
      if (subscriptionId && sellerPubkey) {
        const subscription = await getSubscriptionByStripeId(subscriptionId);
        if (
          subscription &&
          subscription.seller_pubkey === sellerPubkey &&
          normalizeEmail(subscription.buyer_email) ===
            normalizeEmail(buyerEmail)
        ) {
          sellerFromEmail =
            (await resolveSellerSenderEmail(sellerPubkey)) || undefined;
        }
      }
    } catch (err) {
      console.error(
        "Failed to resolve seller sender email for subscription; using global sender:",
        err
      );
      sellerFromEmail = undefined;
    }

    let emailSent = false;

    switch (type) {
      case "confirmation":
        if (!params.productTitle || !params.frequency || !params.currency) {
          return res.status(400).json({
            error:
              "productTitle, frequency, and currency are required for confirmation emails",
          });
        }
        emailSent = await sendSubscriptionConfirmation(
          buyerEmail,
          {
            productTitle: params.productTitle,
            frequency: params.frequency,
            discountPercent: params.discountPercent || 0,
            regularPrice: params.regularPrice || "N/A",
            subscriptionPrice: params.subscriptionPrice || "N/A",
            currency: params.currency,
            nextBillingDate: params.nextBillingDate || "N/A",
            buyerName: params.buyerName,
            shippingAddress: params.shippingAddress,
            orderId: params.orderId,
            subscriptionId: params.subscriptionId,
          },
          branding,
          sellerFromEmail
        );
        break;

      case "renewal_reminder":
        if (!params.productTitle || !params.frequency || !params.currency) {
          return res.status(400).json({
            error:
              "productTitle, frequency, and currency are required for renewal reminder emails",
          });
        }
        emailSent = await sendRenewalReminder(
          buyerEmail,
          {
            productTitle: params.productTitle,
            frequency: params.frequency,
            discountPercent: params.discountPercent || 0,
            regularPrice: params.regularPrice || "N/A",
            subscriptionPrice: params.subscriptionPrice || "N/A",
            currency: params.currency,
            nextBillingDate: params.nextBillingDate || "N/A",
            buyerName: params.buyerName,
            shippingAddress: params.shippingAddress,
            subscriptionId: params.subscriptionId,
          },
          branding,
          sellerFromEmail
        );
        break;

      case "address_change":
        if (!params.productTitle || !params.newAddress) {
          return res.status(400).json({
            error:
              "productTitle and newAddress are required for address change emails",
          });
        }
        emailSent = await sendAddressChangeConfirmation(
          buyerEmail,
          {
            productTitle: params.productTitle,
            newAddress: params.newAddress,
            buyerName: params.buyerName,
            subscriptionId: params.subscriptionId,
          },
          branding,
          sellerFromEmail
        );
        break;

      case "cancellation":
        if (!params.productTitle || !params.endDate) {
          return res.status(400).json({
            error:
              "productTitle and endDate are required for cancellation emails",
          });
        }
        emailSent = await sendSubscriptionCancellation(
          buyerEmail,
          {
            productTitle: params.productTitle,
            buyerName: params.buyerName,
            endDate: params.endDate,
            subscriptionId: params.subscriptionId,
          },
          branding,
          sellerFromEmail
        );
        break;

      default:
        return res.status(400).json({
          error:
            "Invalid type. Must be one of: confirmation, renewal_reminder, address_change, cancellation",
        });
    }

    return res.status(200).json({ success: true, emailSent });
  } catch (error) {
    console.error("Error sending subscription email:", error);
    return res.status(500).json({ error: "Failed to send subscription email" });
  }
}
