import type { NextApiRequest, NextApiResponse } from "next";
import {
  fetchShopProfileByPubkeyFromDb,
  saveSubscriberEmailCapture,
  getEmailFlows,
  getFlowEnrollments,
  enrollInFlow,
  scheduleStepExecutions,
  cancelEnrollment,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { sellerHasProductPageContactForm } from "@/utils/storefront/product-page-contact-form";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import {
  parseSellerShopProfileEvent,
  type StorefrontConfig,
} from "@milk-market/domain";

// Public, visitor-driven (no seller proof), so this is a spam vector for the
// seller's contact list. Mirror the contact-form endpoint's tight rate limit
// AND require the seller to actually have an enabled contact_form section in
// subscription mode before we save anything.
const RATE_LIMIT = { limit: 5, windowMs: 60 * 1000 };

const MAX_EMAIL = 254;
const MAX_PHONE = 50;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Anti-abuse: only accept subscriptions when this seller actually published an
// enabled contact_form section set to "subscription" mode (on the homepage or
// any custom builder page). Without this, anyone could POST any sellerPubkey
// and stuff their contact list.
function hasEnabledSubscriptionForm(
  storefront: StorefrontConfig | undefined
): boolean {
  if (!storefront) return false;
  const enabled = (s: {
    type: string;
    enabled?: boolean;
    contactFormMode?: string;
  }) =>
    s.type === "contact_form" &&
    s.enabled !== false &&
    s.contactFormMode === "subscription";
  if ((storefront.sections || []).some(enabled)) return true;
  if ((storefront.productPageDefaults || []).some(enabled)) return true;
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

  if (!(await applyRateLimit(req, res, "storefront-subscribe", RATE_LIMIT)))
    return;

  const { sellerPubkey } = req.body || {};

  const email =
    typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const phone =
    typeof req.body?.phone === "string" ? req.body.phone.trim() : "";

  if (
    typeof sellerPubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(sellerPubkey)
  ) {
    return res.status(400).json({ error: "Invalid seller" });
  }
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (email.length > MAX_EMAIL || phone.length > MAX_PHONE) {
    return res.status(400).json({ error: "One or more fields are too long" });
  }

  try {
    const profileEvent = await fetchShopProfileByPubkeyFromDb(sellerPubkey);
    const profile = profileEvent
      ? parseSellerShopProfileEvent(profileEvent)
      : null;
    if (
      !hasEnabledSubscriptionForm(profile?.content?.storefront) &&
      !(await sellerHasProductPageContactForm(sellerPubkey, true))
    ) {
      return res
        .status(403)
        .json({ error: "This seller is not accepting subscriptions" });
    }

    // Save the subscriber to the seller's contact list FIRST. This must succeed
    // even if the seller has no welcome series — the subscription itself is the
    // point; the welcome enrollment below is best-effort.
    await saveSubscriberEmailCapture(sellerPubkey, email, phone || null);

    // Best-effort: enroll the new subscriber in the seller's active welcome
    // series, if they have one and an active Herd membership (email flows are
    // Pro-only). Any failure here must not fail the subscription.
    try {
      if (await isPubkeyProEntitled(sellerPubkey)) {
        const flows = await getEmailFlows(sellerPubkey);
        const activeFlow = flows.find(
          (f) => f.flow_type === "welcome_series" && f.status === "active"
        );
        if (activeFlow) {
          const existing = await getFlowEnrollments(activeFlow.id);
          const lowered = email.toLowerCase();
          const alreadyEnrolled = existing.some(
            (e) =>
              (e.recipient_email || "").toLowerCase() === lowered &&
              e.status === "active"
          );
          if (!alreadyEnrolled) {
            let enrollmentId: number | null = null;
            try {
              const enrollment = await enrollInFlow({
                flow_id: activeFlow.id,
                recipient_email: email,
                recipient_pubkey: null,
                enrollment_data: {
                  shop_name: activeFlow.from_name || "Milk Market",
                },
              });
              enrollmentId = enrollment.id;
              // Enrollment + step scheduling are NOT transactional. If
              // scheduling throws after the enrollment row was created, cancel
              // it so the contact is never left "active" with no queued
              // steps (which would make future enrollments skip them forever).
              await scheduleStepExecutions(enrollment.id, activeFlow.id);
            } catch (enrollErr) {
              console.error(
                "Failed to enroll subscriber in welcome series:",
                enrollErr
              );
              if (enrollmentId !== null) {
                try {
                  await cancelEnrollment(enrollmentId);
                } catch (cancelErr) {
                  console.error(
                    "Failed to roll back stranded enrollment:",
                    enrollmentId,
                    cancelErr
                  );
                }
              }
            }
          }
        }
      }
    } catch (flowErr) {
      // Never let a welcome-series problem fail the subscription itself.
      console.error("Welcome-series enrollment check failed:", flowErr);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    // Never log submitted PII.
    console.error("Subscription submission error:", error);
    return res.status(500).json({ error: "Failed to subscribe" });
  }
}
