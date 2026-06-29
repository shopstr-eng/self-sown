import { NextApiRequest, NextApiResponse } from "next";
import {
  sendOrderConfirmationToBuyer,
  sendNewOrderToSeller,
} from "@/utils/email/email-service";
import {
  saveNotificationEmail,
  getSellerNotificationEmail,
  getUserAuthEmail,
  getEmailFlows,
  enrollInFlow,
  scheduleStepExecutions,
  getFlowEnrollments,
  getDbPool,
  recordEmailFlowConversion,
  getStripeConnectAccount,
} from "@/utils/db/db-service";
import { deductStock } from "@/utils/db/inventory-service";
import { resolveExplicitPaymentMethod } from "@/utils/messages/order-message-utils";
import { applyRateLimit } from "@/utils/rate-limit";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "email-send-order", RATE_LIMIT))) return;

  const {
    buyerEmail,
    buyerPubkey,
    sellerPubkey,
    orderId,
    productTitle,
    amount,
    currency,
    paymentMethod,
    buyerName,
    shippingAddress,
    buyerContact,
    buyerEmailForSeller,
    pickupLocation,
    selectedSize,
    selectedVolume,
    selectedWeight,
    selectedVariant,
    variantLabel,
    selectedBulkOption,
    subscriptionFrequency,
    productId,
    productAddress,
    quantity,
    donationAmount,
    donationPercentage,
    salesTax,
    paymentIntentId,
  } = req.body;

  if (!orderId || !productTitle) {
    return res
      .status(400)
      .json({ error: "orderId and productTitle are required" });
  }

  const emailParams = {
    orderId,
    productTitle,
    amount: amount || "N/A",
    currency: currency || "sats",
    paymentMethod: resolveExplicitPaymentMethod(paymentMethod) || "N/A",
    buyerName,
    shippingAddress,
    buyerContact,
    buyerEmail: buyerEmailForSeller || buyerEmail || undefined,
    pickupLocation,
    selectedSize,
    selectedVolume,
    selectedWeight,
    selectedVariant,
    variantLabel,
    selectedBulkOption,
    subscriptionFrequency,
    donationAmount:
      typeof donationAmount === "number" ? donationAmount : undefined,
    donationPercentage:
      typeof donationPercentage === "number" ? donationPercentage : undefined,
    salesTax: typeof salesTax === "number" ? salesTax : undefined,
  };

  const results: { buyerEmailSent: boolean; sellerEmailSent: boolean } = {
    buyerEmailSent: false,
    sellerEmailSent: false,
  };

  try {
    const branding = await loadStorefrontBranding(sellerPubkey);

    // Resolve the seller's own authenticated sending domain once (if any). This
    // is fail-closed: it returns null unless the domain is SendGrid-validated
    // and the from-address is set, so order emails fall back to the global
    // verified sender and delivery is never broken.
    const sellerFromEmail = sellerPubkey
      ? await resolveSellerSenderEmail(sellerPubkey)
      : null;

    // Resolve the seller's notification email first so we can route a buyer's
    // reply to the order confirmation straight to the seller (Reply-To). Guard
    // this lookup so a transient failure can't block the buyer confirmation.
    let sellerEmail: string | null = null;
    if (sellerPubkey) {
      try {
        sellerEmail = await getSellerNotificationEmail(sellerPubkey);
        if (!sellerEmail) {
          sellerEmail = await getUserAuthEmail(sellerPubkey);
        }
      } catch (sellerLookupError) {
        console.error(
          "Failed to resolve seller notification email:",
          sellerLookupError
        );
      }
    }

    const buyerReplyEmail = buyerEmailForSeller || buyerEmail || undefined;

    if (buyerEmail) {
      await saveNotificationEmail(
        buyerEmail,
        "buyer",
        buyerPubkey || undefined,
        orderId
      );

      // The buyer confirmation goes to a caller-supplied address, so it may only
      // use the seller's own authenticated domain when a real CARD payment to
      // this seller is verified with Stripe (and pinned to this recipient).
      // Lightning/Cashu/manual orders carry no such server-side proof and always
      // fall back to the global verified sender, so delivery is never broken.
      let buyerConfirmationFromEmail: string | undefined;
      if (sellerFromEmail) {
        const cardPaymentVerified = await verifyCardPaymentForSeller({
          paymentIntentId,
          sellerPubkey,
          buyerEmail,
        });
        if (cardPaymentVerified) {
          buyerConfirmationFromEmail = sellerFromEmail;
        }
      }

      results.buyerEmailSent = await sendOrderConfirmationToBuyer(
        buyerEmail,
        { ...emailParams, sellerContact: sellerEmail || undefined },
        branding,
        sellerEmail || undefined,
        buyerConfirmationFromEmail
      );
    }

    if (sellerEmail) {
      results.sellerEmailSent = await sendNewOrderToSeller(
        sellerEmail,
        emailParams,
        branding,
        buyerReplyEmail,
        sellerFromEmail || undefined
      );
    }

    if (buyerEmail && sellerPubkey) {
      try {
        await autoEnrollInFlows({
          buyerEmail,
          buyerPubkey,
          sellerPubkey,
          orderId,
          productTitle,
          productAddress,
          amount,
          currency,
          buyerName,
        });
      } catch (enrollError) {
        console.error("Error auto-enrolling in email flows:", enrollError);
      }

      // Last-touch attribution: credit this order to the buyer's most recent
      // flow email click (30d) or send (7d) for this seller, if any. The
      // just-created enrollment above can't self-attribute (its executions are
      // still pending, not sent). Best-effort — never blocks the order.
      try {
        await recordEmailFlowConversion({
          sellerPubkey,
          buyerEmail,
          orderId,
          amount,
          currency,
        });
      } catch (convError) {
        console.error("Error recording email flow conversion:", convError);
      }
    }

    if (productId && orderId) {
      try {
        const deductQty = quantity ? parseInt(String(quantity), 10) : 1;
        const bulkMultiplier = selectedBulkOption
          ? parseInt(String(selectedBulkOption), 10)
          : 1;
        const effectiveDeductQty =
          deductQty * (isNaN(bulkMultiplier) ? 1 : bulkMultiplier);
        const variantKey = selectedSize ? `size:${selectedSize}` : "_default";
        await deductStock(productId, effectiveDeductQty, orderId, variantKey);
      } catch (invErr) {
        console.error("Inventory deduction failed (frontend order):", invErr);
      }
    }

    return res.status(200).json({ success: true, ...results });
  } catch (error) {
    console.error("Error sending order emails:", error);
    return res.status(500).json({ error: "Failed to send order emails" });
  }
}

async function autoEnrollInFlows(params: {
  buyerEmail: string;
  buyerPubkey?: string;
  sellerPubkey: string;
  orderId: string;
  productTitle: string;
  productAddress?: string;
  amount?: string;
  currency?: string;
  buyerName?: string;
}) {
  const {
    buyerEmail,
    buyerPubkey,
    sellerPubkey,
    orderId,
    productTitle,
    productAddress,
    amount,
    currency,
    buyerName,
  } = params;

  const flows = await getEmailFlows(sellerPubkey);
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";
  const enrollmentData = {
    order_id: orderId,
    product_title: productTitle,
    buyer_name: buyerName || "",
    amount: amount || "N/A",
    currency: currency || "sats",
    shop_url: `${baseUrl}/${sellerPubkey}`,
    // Scopes {{review_link}} to the exact product when known (single-product
    // checkout). Omitted for multi-seller carts; the link then matches on
    // order_id alone.
    ...(productAddress ? { product_address: productAddress } : {}),
  };

  const postPurchaseFlow = flows.find(
    (f) => f.flow_type === "post_purchase" && f.status === "active"
  );
  if (postPurchaseFlow) {
    const flowData = {
      ...enrollmentData,
      shop_name: postPurchaseFlow.from_name || "Milk Market",
    };
    await tryEnroll(postPurchaseFlow.id, buyerEmail, buyerPubkey, flowData);
  }

  const welcomeFlow = flows.find(
    (f) => f.flow_type === "welcome_series" && f.status === "active"
  );
  if (welcomeFlow) {
    const isFirstOrder = await checkIsFirstOrderFromSeller(
      buyerEmail,
      sellerPubkey,
      orderId
    );
    if (isFirstOrder) {
      const flowData = {
        ...enrollmentData,
        shop_name: welcomeFlow.from_name || "Milk Market",
      };
      await tryEnroll(welcomeFlow.id, buyerEmail, buyerPubkey, flowData);
    }
  }
}

async function tryEnroll(
  flowId: number,
  recipientEmail: string,
  recipientPubkey?: string,
  enrollmentData?: any
) {
  const existingEnrollments = await getFlowEnrollments(flowId);
  const alreadyEnrolled = existingEnrollments.some(
    (e) => e.recipient_email === recipientEmail && e.status === "active"
  );
  if (alreadyEnrolled) return;

  const enrollment = await enrollInFlow({
    flow_id: flowId,
    recipient_email: recipientEmail,
    recipient_pubkey: recipientPubkey || null,
    enrollment_data: enrollmentData,
  });

  await scheduleStepExecutions(enrollment.id, flowId);
}

async function checkIsFirstOrderFromSeller(
  buyerEmail: string,
  sellerPubkey: string,
  currentOrderId: string
): Promise<boolean> {
  const dbPool = getDbPool();
  let client;

  try {
    client = await dbPool.connect();
    const result = await client.query(
      `SELECT COUNT(*) as count FROM notification_emails ne
       INNER JOIN message_events me ON ne.order_id = me.order_id
       WHERE ne.email = $1 AND ne.role = 'buyer'
       AND ne.order_id != $2
       AND me.pubkey = $3`,
      [buyerEmail, currentOrderId, sellerPubkey]
    );
    return parseInt(result.rows[0].count, 10) === 0;
  } catch (error) {
    console.error("Error checking first order:", error);
    return true;
  } finally {
    if (client) client.release();
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Verify that `paymentIntentId` is a real, succeeded Stripe card payment that
// genuinely belongs to `sellerPubkey` and was charged to `buyerEmail`. This is
// the gate that lets a buyer's order confirmation send from the seller's own
// authenticated domain without being spoofable: a single-seller order is a
// direct charge that only resolves on the seller's connected account, and a
// multi-merchant cart names the seller in its server-built `sellerSplits`
// metadata — neither can be forged by a caller. The recipient is pinned to the
// address Stripe holds on the charge so a genuine payment can't be replayed to
// send a seller-branded email to someone else. Fail-closed: any uncertainty
// returns false and the confirmation falls back to the global verified sender.
async function verifyCardPaymentForSeller(params: {
  paymentIntentId?: string;
  sellerPubkey?: string;
  buyerEmail?: string;
}): Promise<boolean> {
  const { paymentIntentId, sellerPubkey, buyerEmail } = params;
  if (!paymentIntentId || !sellerPubkey || !buyerEmail) return false;
  if (!process.env.STRIPE_SECRET_KEY) return false;

  try {
    let paymentIntent: Stripe.PaymentIntent | null = null;

    // Strongest proof: single-seller orders are direct charges on the seller's
    // OWN connected account, so the PaymentIntent only resolves there.
    const connect = await getStripeConnectAccount(sellerPubkey);
    if (connect?.stripe_account_id) {
      try {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
          stripeAccount: connect.stripe_account_id,
        });
      } catch {
        paymentIntent = null;
      }
    }

    // Multi-merchant cart: the PaymentIntent lives on the platform account and
    // names each participating seller (with a server-resolved connected
    // account) in `sellerSplits`. The seller must be listed there.
    if (!paymentIntent) {
      const platformPi = await stripe.paymentIntents.retrieve(paymentIntentId);
      const splitsRaw = platformPi.metadata?.sellerSplits;
      if (splitsRaw) {
        try {
          const splits = JSON.parse(splitsRaw);
          if (
            Array.isArray(splits) &&
            splits.some((s: { pubkey?: string }) => s?.pubkey === sellerPubkey)
          ) {
            paymentIntent = platformPi;
          }
        } catch {
          // Malformed metadata -> treat as unverified.
        }
      }
    }

    if (!paymentIntent) return false;
    if (paymentIntent.status !== "succeeded") return false;

    const receiptEmail = paymentIntent.receipt_email;
    if (!receiptEmail) return false;
    if (normalizeEmail(receiptEmail) !== normalizeEmail(buyerEmail)) {
      return false;
    }

    return true;
  } catch (error) {
    console.error("Card payment verification failed:", error);
    return false;
  }
}
