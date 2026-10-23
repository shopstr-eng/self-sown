import type { NextApiRequest, NextApiResponse } from "next";
import { markDiscountCodeUsed } from "@/utils/db/db-service";
import {
  applyRateLimit,
  checkRateLimit,
  getRequestIp,
} from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "db-discount-code-used", RATE_LIMIT)))
    return;

  const { code, pubkey } = req.body;

  if (!code || !pubkey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Unauthenticated by design (guest checkouts consume codes post-payment), so
  // bound abuse: a tight per-IP+code budget stops "burn every use of this
  // seller's limited-use code" attacks that the global limit alone allows.
  const codeKey = `${String(pubkey).toLowerCase()}:${String(code)
    .trim()
    .toUpperCase()}`.slice(0, 200);
  const perCode = await checkRateLimit(
    "db-discount-code-used:code",
    `${getRequestIp(req)}:${codeKey}`,
    { limit: 10, windowMs: 60 * 60 * 1000 },
    res
  );
  if (!perCode.ok) {
    return res.status(429).json({ error: "Too many requests" });
  }

  try {
    await markDiscountCodeUsed(code, pubkey);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Failed to mark discount code used:", error);
    return res.status(500).json({ error: "Failed to update" });
  }
}
