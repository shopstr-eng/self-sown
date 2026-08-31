import type { NextApiRequest, NextApiResponse } from "next";

import {
  transitionSellerOrderStatus,
  type CanonicalOrderStatus,
} from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";

const PER_IP_LIMIT = { limit: 300, windowMs: 60 * 1000 };
const PER_PUBKEY_LIMIT = { limit: 200, windowMs: 60 * 1000 };
const HEX_64 = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRANSITION_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const ORDER_STATUSES = new Set([
  "pending",
  "confirmed",
  "shipped",
  "completed",
  "canceled",
]);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store");

  if (
    !(await applyRateLimit(req, res, "update-order-status:ip", PER_IP_LIMIT))
  ) {
    return;
  }

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "update-order-status:pubkey",
      PER_PUBKEY_LIMIT,
      authResult.pubkey
    ))
  ) {
    return;
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const {
    orderId,
    expectedStatus,
    status,
    messageId,
    sellerPubkey,
    buyerPubkey,
    transitionId,
  } = req.body;

  if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) {
    return res.status(400).json({ error: "Invalid orderId" });
  }
  if (
    messageId !== undefined &&
    (typeof messageId !== "string" || !HEX_64.test(messageId))
  ) {
    return res.status(400).json({ error: "Invalid messageId" });
  }
  if (typeof sellerPubkey !== "string" || !HEX_64.test(sellerPubkey)) {
    return res.status(400).json({ error: "Invalid sellerPubkey" });
  }
  if (
    buyerPubkey !== null &&
    buyerPubkey !== undefined &&
    (typeof buyerPubkey !== "string" || !HEX_64.test(buyerPubkey))
  ) {
    return res.status(400).json({ error: "Invalid buyerPubkey" });
  }
  if (typeof transitionId !== "string" || !TRANSITION_ID.test(transitionId)) {
    return res.status(400).json({ error: "Invalid transitionId" });
  }
  if (
    typeof expectedStatus !== "string" ||
    typeof status !== "string" ||
    !ORDER_STATUSES.has(expectedStatus) ||
    !ORDER_STATUSES.has(status) ||
    status === "pending"
  ) {
    return res.status(400).json({ error: "Invalid status transition" });
  }

  try {
    const result = await transitionSellerOrderStatus({
      actorPubkey: authResult.pubkey,
      buyerPubkey: buyerPubkey ?? null,
      expectedStatus: expectedStatus as CanonicalOrderStatus,
      messageId,
      orderId,
      sellerPubkey,
      status: status as Exclude<CanonicalOrderStatus, "pending">,
      transitionId,
    });

    if (result.outcome === "forbidden") {
      return res
        .status(403)
        .json({ error: "You are not allowed to update this order." });
    }
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: "Order message not found." });
    }
    if (result.outcome === "conflict") {
      return res.status(409).json({
        error: "Order status changed. Refresh before retrying.",
        ...(result.currentStatus
          ? { currentStatus: result.currentStatus }
          : {}),
      });
    }

    return res.status(200).json({
      success: true,
      orderId,
      status,
      persisted: true,
      version: result.version,
    });
  } catch (error) {
    console.error("Failed to update order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
}
