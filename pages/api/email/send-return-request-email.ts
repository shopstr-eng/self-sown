import { NextApiRequest, NextApiResponse } from "next";
import { nip19 } from "nostr-tools";
import { sendReturnRequestToSeller } from "@/utils/email/email-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import {
  getSellerNotificationEmail,
  getUserAuthEmail,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "email-send-return", RATE_LIMIT)))
    return;

  const {
    orderId,
    productTitle,
    requestType,
    message,
    sellerPubkey,
    buyerName,
  } = req.body;

  if (!orderId || !productTitle || !requestType || !message || !sellerPubkey) {
    return res.status(400).json({
      error:
        "orderId, productTitle, requestType, message, and sellerPubkey are required",
    });
  }

  // NIP-98: this sends an attacker-writable "buyer wants a refund" message to
  // a seller's inbox under the seller's own domain branding, so the requester
  // must be signed in (orders are encrypted DMs — the server cannot verify
  // the buyer/order relationship itself).
  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }
  // buyerName carries the requester's npub; when it does, it must be the
  // signer, so one signed-in user can't file return requests as another buyer.
  if (typeof buyerName === "string" && buyerName.startsWith("npub1")) {
    let buyerHex: string | null = null;
    try {
      const decoded = nip19.decode(buyerName);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        buyerHex = decoded.data;
      }
    } catch {
      buyerHex = null;
    }
    if (buyerHex !== authResult.pubkey) {
      return res
        .status(403)
        .json({ error: "buyerName must match the authenticated requester" });
    }
  }

  try {
    let sellerEmail = await getSellerNotificationEmail(sellerPubkey);
    if (!sellerEmail) {
      sellerEmail = await getUserAuthEmail(sellerPubkey);
    }

    if (!sellerEmail) {
      return res.status(200).json({
        success: true,
        emailSent: false,
        reason: "No seller email found",
      });
    }

    const branding = await loadStorefrontBranding(sellerPubkey);
    // Send from the seller's own authenticated domain when valid (fail-closed
    // null otherwise); sendEmail falls back to the global verified sender.
    const sellerFromEmail = await resolveSellerSenderEmail(sellerPubkey);
    const emailSent = await sendReturnRequestToSeller(
      sellerEmail,
      {
        orderId,
        productTitle,
        requestType,
        message,
        buyerName,
      },
      branding,
      sellerFromEmail || undefined
    );

    return res.status(200).json({ success: true, emailSent });
  } catch (error) {
    console.error("Error sending return request email:", error);
    return res
      .status(500)
      .json({ error: "Failed to send return request email" });
  }
}
