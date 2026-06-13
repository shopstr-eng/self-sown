/**
 * Seller-private email-flow analytics.
 *
 * Returns per-flow and per-email stats (sends, opens, clicks, conversions and
 * the derived rates, plus the most-clicked links) for the authenticated seller.
 * One-time emails are included automatically — they are just flows of type
 * `one_time`.
 *
 * Unlike the open `GET /api/email/flows?seller_pubkey=` listing, this exposes
 * business performance data (incl. conversions), so it requires NIP-98 auth and
 * serves only the authenticated pubkey's own data — there is no way to read
 * another seller's stats. Email analytics is also a paid Herd feature, so the
 * authenticated seller must hold an active membership.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { getEmailFlowStatsForSeller } from "@/utils/db/db-service";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "email-flow-stats", RATE_LIMIT)) return;

  const authResult = await verifyNip98Request(req, req.method);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  // Email analytics is a paid Herd feature. Gate on entitlement so lapsed
  // sellers (and free sellers who somehow have flows) can't read business
  // performance + conversion data even with a valid signature.
  if (!(await requireProEntitlement(authResult.pubkey, res))) return;

  try {
    const flows = await getEmailFlowStatsForSeller(authResult.pubkey);
    return res.status(200).json({ flows });
  } catch (err) {
    console.error("email-flow stats error:", err);
    return res.status(500).json({ error: "Failed to load email stats" });
  }
}
