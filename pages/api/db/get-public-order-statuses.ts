import type { NextApiRequest, NextApiResponse } from "next";

import { getOrderStatuses } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

// Anonymous compatibility endpoint for buyer-side polling. Callers must know
// both the seller pubkey and opaque order ID. Seller/mobile reads use the
// separate NIP-98-protected get-order-statuses endpoint.
const RATE_LIMIT = { limit: 300, windowMs: 60 * 1000 };
const HEX_64 = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ORDER_IDS = 200;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store");
  if (
    !(await applyRateLimit(req, res, "get-public-order-statuses", RATE_LIMIT))
  ) {
    return;
  }

  const sellerPubkey = req.body?.sellerPubkey;
  const orderIds = req.body?.orderIds;
  if (typeof sellerPubkey !== "string" || !HEX_64.test(sellerPubkey)) {
    return res.status(400).json({ error: "Invalid sellerPubkey" });
  }
  if (!Array.isArray(orderIds)) {
    return res.status(400).json({ error: "Invalid orderIds" });
  }

  const normalizedOrderIds: string[] = [];
  for (const value of orderIds) {
    if (typeof value !== "string") {
      return res.status(400).json({ error: "Invalid order ID" });
    }
    const orderId = value.trim();
    if (!ORDER_ID.test(orderId)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }
    normalizedOrderIds.push(orderId);
  }
  if (normalizedOrderIds.length > MAX_ORDER_IDS) {
    return res.status(413).json({ error: "Too many order IDs" });
  }

  const uniqueOrderIds = Array.from(new Set(normalizedOrderIds));
  if (uniqueOrderIds.length === 0) {
    return res.status(200).json({ statuses: {} });
  }

  try {
    const statuses = await getOrderStatuses(uniqueOrderIds, sellerPubkey);
    return res.status(200).json({ statuses });
  } catch (error) {
    console.error("Failed to get public order statuses:", error);
    return res.status(500).json({ error: "Failed to get order statuses" });
  }
}
