/**
 * Decode a signed {{review_link}} token. Called by the orders dashboard when a
 * buyer arrives via a "leave a review" link from a flow email. Returns the
 * order/product/seller the token points at so the dashboard can find the
 * matching decrypted order and auto-open the Nostr review modal.
 *
 * No auth: the token only PRE-FILLS the review UI; posting a review still
 * requires the buyer's own Nostr signature. Rate-limited to blunt brute-force.
 * Must stay reachable on seller custom domains (covered by the `/api/email/`
 * allow-list in proxy.ts).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyReviewLinkToken } from "@/utils/email/review-link-tokens";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "email-flow-review-link", RATE_LIMIT)) return;

  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    return res.status(400).json({ ok: false, error: "Missing token" });
  }

  const decoded = verifyReviewLinkToken(token);
  if (!decoded) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid or expired token" });
  }

  return res.status(200).json({
    ok: true,
    orderId: decoded.orderId,
    productAddress: decoded.productAddress,
    sellerPubkey: decoded.sellerPubkey,
    buyerPubkey: decoded.buyerPubkey,
  });
}
