import type { NextApiRequest, NextApiResponse } from "next";
import { getSellerEmailUnsubscribeCounts } from "@/utils/db/db-service";
import { checkRateLimit, getRequestIp } from "@/utils/rate-limit";

// Read-only per-seller breakdown of WHY contacts left the email audience:
// deliberate opt-outs vs provider dead-address suppressions. Mirrors the
// sender-domain GET contract (pubkey query param, no auth event — the counts
// are aggregates, not contact data, and this page's other seller stats are
// fetched the same way).
const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rate = await checkRateLimit(
    "email-unsubscribe-counts",
    getRequestIp(req),
    RATE_LIMIT
  );
  if (!rate.ok) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { pubkey } = req.query;
  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "pubkey parameter required" });
  }

  const counts = await getSellerEmailUnsubscribeCounts(pubkey);
  if (!counts) {
    // DB outage: fail loud, never render zeros that look like "nobody left".
    return res.status(503).json({ error: "Could not load unsubscribe counts" });
  }
  return res.status(200).json(counts);
}
