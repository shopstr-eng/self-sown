import type { NextApiRequest, NextApiResponse } from "next";

import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  getSquareOrderPaidStatus,
  getSquarePaymentLinkOrderId,
  getValidSquareAccessToken,
} from "@/utils/square/square-api";
import { isSquareConfigured } from "@/utils/square/square-config";

// Poll target for the mobile PoS Square rail: resolve the payment link's
// order and report whether the buyer's card payment settled. Reads run under
// the authenticated seller's own token, so a seller can only inspect their
// own links.
const RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await applyRateLimit(req, res, "square-pos-link-status", RATE_LIMIT)))
    return;

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  if (!isSquareConfigured()) {
    return res
      .status(503)
      .json({ error: "Square is not available", code: "square_unconfigured" });
  }

  const { linkId, orderId } = req.body ?? {};
  if (typeof linkId !== "string" || !linkId || linkId.length > 128) {
    return res.status(400).json({ error: "Invalid linkId" });
  }

  const access = await getValidSquareAccessToken(authResult.pubkey);
  if (!access) {
    return res.status(403).json({
      error: "Connect a Square account first",
      code: "square_not_connected",
    });
  }

  try {
    const resolvedOrderId =
      typeof orderId === "string" && orderId
        ? orderId
        : await getSquarePaymentLinkOrderId(access.accessToken, linkId);
    if (!resolvedOrderId) {
      return res.status(200).json({ paid: false });
    }
    const status = await getSquareOrderPaidStatus(
      access.accessToken,
      resolvedOrderId
    );
    return res.status(200).json({
      paid: status.paid,
      ...(status.paymentId ? { paymentId: status.paymentId } : {}),
    });
  } catch (error) {
    console.error("square pos-link-status failed:", error);
    return res
      .status(502)
      .json({ error: "Could not check the Square payment status" });
  }
}
