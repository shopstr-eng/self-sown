import { NextApiRequest, NextApiResponse } from "next";
import { getEmailFlow } from "@/utils/db/db-service";
import {
  renderFlowEmail,
  FlowEmailStorefrontStyle,
  MergeTagData,
} from "@/utils/email/flow-email-templates";
import { sendEmail } from "@/utils/email/email-service";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 5, windowMs: 60 * 1000 };

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "email-flows-send-test", RATE_LIMIT)) return;

  const { flowId } = req.query;
  const flowIdNum = parseInt(flowId as string, 10);
  if (isNaN(flowIdNum)) {
    return res.status(400).json({ error: "Invalid flow ID" });
  }

  // Require a NIP-98 proof from the seller. This test sends from the seller's
  // OWN SendGrid-authenticated domain (DKIM-aligned) to a caller-supplied
  // address, so without proof of seller ownership an unauthenticated caller
  // could emit spoofed mail from that domain to anyone. Mirrors the sibling
  // send-to-contacts endpoint, which is NIP-98 authed for the same reason.
  const authResult = await verifyNip98Request(req, "POST");
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  const {
    target_email,
    subject,
    body_html,
    shop_name,
    shop_url,
    storefront_style,
  } = req.body as {
    target_email?: string;
    subject?: string;
    body_html?: string;
    shop_name?: string;
    shop_url?: string;
    storefront_style?: FlowEmailStorefrontStyle | null;
  };

  if (!target_email || !isValidEmail(target_email)) {
    return res.status(400).json({ error: "A valid target_email is required" });
  }
  if (typeof subject !== "string" || typeof body_html !== "string") {
    return res
      .status(400)
      .json({ error: "subject and body_html are required" });
  }

  try {
    const flow = await getEmailFlow(flowIdNum);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    if (flow.seller_pubkey !== authResult.pubkey) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

    const mergeData: MergeTagData = {
      buyer_name: "Test Buyer",
      shop_name: shop_name || flow.from_name || "Your Shop",
      product_title: "Sample Product",
      order_id: "TEST-12345",
      shop_url: shop_url || `${baseUrl}/${flow.seller_pubkey}`,
    };

    // Apply the seller's stall styling by default so the test matches what real
    // recipients receive (which process.ts styles from the saved storefront).
    // The dashboard may pass a live preview style reflecting unsaved color edits;
    // honor that when present, otherwise fall back to the seller's saved branding.
    let effectiveStyle: FlowEmailStorefrontStyle | undefined =
      storefront_style || undefined;
    if (!effectiveStyle) {
      const branding = await loadStorefrontBranding(authResult.pubkey);
      effectiveStyle = branding?.style;
    }

    const { subject: rendered_subject, html } = renderFlowEmail(
      subject,
      body_html,
      mergeData,
      effectiveStyle
    );

    const testSubject = `[TEST] ${rendered_subject}`;
    const replyTo = flow.reply_to || undefined;

    // The seller is now authenticated and proven to own this flow, so it is safe
    // to send the test from their own authenticated domain when valid — the
    // preview then matches what real recipients will see. resolveSellerSenderEmail
    // is fail-closed (null unless valid) and sendEmail falls back to the global
    // verified sender, so the test can never fail to send.
    const sellerFromEmail = await resolveSellerSenderEmail(authResult.pubkey);

    const ok = await sendEmail(
      target_email,
      testSubject,
      html,
      replyTo,
      undefined,
      undefined,
      sellerFromEmail || undefined
    );
    if (!ok) {
      return res
        .status(500)
        .json({ error: "Failed to send test email. Check server logs." });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error sending test flow email:", error);
    return res.status(500).json({ error: "Failed to send test email" });
  }
}
