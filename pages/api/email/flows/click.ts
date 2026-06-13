/**
 * Public click-tracking redirect for custom email flow links.
 *
 * Recipients hit this when they click a CTA button/link in a flow email. The
 * destination is carried inside a signed token (see `flow-link-tracking.ts`),
 * so we only ever redirect to a URL we signed — there is no open-redirect.
 * Recording the click is best-effort; a failed insert must never block the
 * redirect. We deliberately store no IP/user-agent/recipient email here.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyFlowLinkToken } from "@/utils/email/flow-link-tracking";
import { recordFlowClick } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 240, windowMs: 60 * 1000 };
const SAFE_FALLBACK = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "email-flow-click", RATE_LIMIT)) return;

  const raw = req.query.t;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const decoded = token ? verifyFlowLinkToken(token) : null;

  // Invalid/tampered/expired token: never redirect to untrusted input.
  if (!decoded) {
    return res.redirect(302, SAFE_FALLBACK);
  }

  try {
    await recordFlowClick({
      flowId: decoded.flowId,
      stepId: decoded.stepId,
      enrollmentId: decoded.enrollmentId,
      executionId: decoded.executionId,
      sellerPubkey: decoded.sellerPubkey,
      destinationUrl: decoded.destinationUrl,
    });
  } catch (err) {
    console.error("email-flow click record error:", err);
    // Best-effort: a recording failure must not break the recipient's click.
  }

  // destinationUrl was validated as http/https inside the signed token.
  return res.redirect(302, decoded.destinationUrl);
}
