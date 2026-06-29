import type { NextApiRequest, NextApiResponse } from "next";
import { sendContactFormNotification } from "@/utils/email/email-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import {
  getSellerNotificationEmail,
  getUserAuthEmail,
  fetchShopProfileByPubkeyFromDb,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import {
  parseSellerShopProfileEvent,
  type StorefrontConfig,
} from "@milk-market/domain";

// This endpoint is public and visitor-driven (no seller proof), so it is a spam
// vector for a seller's inbox. We rate-limit it tighter than the popup capture
// (10/min) AND require the seller to actually have an enabled contact_form
// section before we send anything.
const RATE_LIMIT = { limit: 5, windowMs: 60 * 1000 };

const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_PHONE = 50;
const MAX_MESSAGE = 2000;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getSellerEmail(pubkey: string): Promise<string | null> {
  let email = await getSellerNotificationEmail(pubkey);
  if (!email) {
    email = await getUserAuthEmail(pubkey);
  }
  return email;
}

function hasEnabledContactForm(
  storefront: StorefrontConfig | undefined
): boolean {
  if (!storefront) return false;
  const enabled = (s: { type: string; enabled?: boolean }) =>
    s.type === "contact_form" && s.enabled !== false;
  if ((storefront.sections || []).some(enabled)) return true;
  return (storefront.pages || []).some((page) =>
    (page.sections || []).some(enabled)
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "storefront-contact-form", RATE_LIMIT)))
    return;

  const { sellerPubkey } = req.body || {};

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email =
    typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const phone =
    typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (
    typeof sellerPubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(sellerPubkey)
  ) {
    return res.status(400).json({ error: "Invalid seller" });
  }
  // Email is the only required field now. Name, phone, and message are optional
  // inputs the seller can show/hide per section, so we must not reject when the
  // name (or any other optional field) is missing.
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (
    name.length > MAX_NAME ||
    email.length > MAX_EMAIL ||
    phone.length > MAX_PHONE ||
    message.length > MAX_MESSAGE
  ) {
    return res.status(400).json({ error: "One or more fields are too long" });
  }

  try {
    // Anti-abuse: refuse to relay mail unless this seller actually published an
    // enabled contact_form section. Without this, anyone could POST any
    // sellerPubkey and farm their inbox through the platform.
    const profileEvent = await fetchShopProfileByPubkeyFromDb(sellerPubkey);
    const profile = profileEvent
      ? parseSellerShopProfileEvent(profileEvent)
      : null;
    if (!hasEnabledContactForm(profile?.content?.storefront)) {
      return res
        .status(403)
        .json({ error: "This seller is not accepting contact messages" });
    }

    // Server-resolved seller email — never caller-supplied. If the seller has no
    // email on file the section should never have been addable, so fail closed.
    const recipientEmail = await getSellerEmail(sellerPubkey);
    if (!recipientEmail) {
      return res
        .status(400)
        .json({ error: "This seller is not accepting contact messages" });
    }

    // Brand with the seller's stall and send from their own SendGrid-validated
    // domain when available (fail-closed null otherwise). Recipient is the
    // seller's own server-resolved address, so a custom from-address is safe.
    const branding = await loadStorefrontBranding(sellerPubkey);
    const sellerFromEmail = await resolveSellerSenderEmail(sellerPubkey);

    const sent = await sendContactFormNotification(
      recipientEmail,
      {
        name: name || "A storefront visitor",
        email: email || undefined,
        phone: phone || undefined,
        message: message || undefined,
      },
      branding,
      sellerFromEmail || undefined
    );

    if (!sent) {
      // Don't tell the visitor their message was delivered when it wasn't.
      return res.status(502).json({ error: "Failed to send your message" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    // Never log submitted PII / message contents.
    console.error("Contact form submission error:", error);
    return res.status(500).json({ error: "Failed to send your message" });
  }
}
