import { NextApiRequest, NextApiResponse } from "next";
import { sendInquiryNotification } from "@/utils/email/email-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import {
  getSellerNotificationEmail,
  getUserAuthEmail,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

async function getEmailForPubkey(pubkey: string): Promise<string | null> {
  let email = await getSellerNotificationEmail(pubkey);
  if (!email) {
    email = await getUserAuthEmail(pubkey);
  }
  return email;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "email-send-inquiry", RATE_LIMIT)))
    return;

  const { senderPubkey, recipientPubkey, message, senderName } = req.body;

  if (!senderPubkey || !recipientPubkey || !message) {
    return res.status(400).json({
      error: "senderPubkey, recipientPubkey, and message are required",
    });
  }

  // NIP-98: the caller writes an arbitrary message that lands in a seller's
  // inbox branded with that seller's authenticated domain, so the sender must
  // be a signed-in user — and can only send as themselves.
  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }
  if (senderPubkey !== authResult.pubkey) {
    return res
      .status(403)
      .json({ error: "senderPubkey must match the authenticated sender" });
  }

  try {
    const [senderEmail, recipientEmail] = await Promise.all([
      getEmailForPubkey(senderPubkey),
      getEmailForPubkey(recipientPubkey),
    ]);

    if (!senderEmail && !recipientEmail) {
      return res.status(200).json({
        success: true,
        emailsSent: 0,
        reason: "Neither party has an email on file",
      });
    }

    const displayName = senderName || `User ${senderPubkey.slice(0, 8)}...`;
    let emailsSent = 0;

    if (recipientEmail) {
      // Inquiries land in the seller's inbox — brand with their stall so the
      // email matches the storefront the buyer engaged with.
      const branding = await loadStorefrontBranding(recipientPubkey);
      // Inquiries land in the seller's inbox; send from their own authenticated
      // domain when valid (fail-closed null otherwise) so it matches the
      // storefront. sendEmail falls back to the global verified sender.
      const sellerFromEmail = await resolveSellerSenderEmail(recipientPubkey);
      const sent = await sendInquiryNotification(
        recipientEmail,
        {
          senderName: displayName,
          message,
          senderHasEmail: !!senderEmail,
          senderEmail: senderEmail || undefined,
        },
        branding,
        sellerFromEmail || undefined
      );
      if (sent) emailsSent++;
    }

    return res.status(200).json({ success: true, emailsSent });
  } catch (error) {
    console.error("Error sending inquiry email:", error);
    return res.status(500).json({ error: "Failed to send inquiry email" });
  }
}
