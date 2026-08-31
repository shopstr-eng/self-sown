import type { NextApiRequest, NextApiResponse } from "next";

import { getOrderStatuses } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };
const MAX_ORDER_IDS_PER_REQUEST = (() => {
  const configured = Number.parseInt(
    process.env.MAX_ORDER_IDS_PER_REQUEST || "",
    10
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 200;
})();
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeOrderIds(orderIds: unknown): string[] | null {
  if (orderIds === null || orderIds === undefined) {
    return [];
  }
  if (!Array.isArray(orderIds)) {
    return null;
  }

  const normalized: string[] = [];
  for (const value of orderIds) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store");

  if (!(await applyRateLimit(req, res, "get-order-statuses", RATE_LIMIT))) {
    return;
  }

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  const normalizedOrderIds = normalizeOrderIds(req.body?.orderIds);
  if (normalizedOrderIds === null) {
    return res.status(400).json({
      error: "Invalid orderIds. Expected an array of strings.",
    });
  }
  if (normalizedOrderIds.length > MAX_ORDER_IDS_PER_REQUEST) {
    return res.status(413).json({
      error: `Too many order IDs. Maximum allowed is ${MAX_ORDER_IDS_PER_REQUEST}.`,
    });
  }
  if (normalizedOrderIds.some((id) => !ORDER_ID.test(id))) {
    return res.status(400).json({ error: "Invalid order ID" });
  }

  const orderIdArray = Array.from(new Set(normalizedOrderIds));
  if (orderIdArray.length === 0) {
    return res.status(200).json({ statuses: {} });
  }

  try {
    const statuses = await getOrderStatuses(orderIdArray, authResult.pubkey);
    return res.status(200).json({ statuses });
  } catch (error) {
    console.error("Failed to get order statuses:", error);
    return res.status(500).json({ error: "Failed to get order statuses" });
  }
}
