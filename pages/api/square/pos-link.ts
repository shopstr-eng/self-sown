import type { NextApiRequest, NextApiResponse } from "next";

import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  createSquarePaymentLink,
  getValidSquareAccessToken,
} from "@/utils/square/square-api";
import { isSquareConfigured } from "@/utils/square/square-config";

// Mobile PoS Square rail: create a hosted quick_pay checkout link for the
// authenticated seller's own Square account. The seller's phone shows the link
// as a QR; the buyer opens it and taps their card on THEIR device. Token,
// location and settlement currency all come server-side from the seller's
// stored connection — the client supplies only the buyer-facing amount and
// sale metadata, same trust model as square/create-payment.
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await applyRateLimit(req, res, "square-pos-link", RATE_LIMIT))) return;

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  if (!isSquareConfigured()) {
    return res
      .status(503)
      .json({ error: "Square is not available", code: "square_unconfigured" });
  }

  const { amountSmallest, currency, orderId, title, note } = req.body ?? {};
  if (
    typeof amountSmallest !== "number" ||
    !Number.isInteger(amountSmallest) ||
    amountSmallest < 1 ||
    amountSmallest > 99_999_999
  ) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    return res.status(400).json({ error: "Invalid currency" });
  }
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) {
    return res.status(400).json({ error: "Invalid orderId" });
  }

  const access = await getValidSquareAccessToken(authResult.pubkey);
  if (!access?.locationId) {
    return res.status(403).json({
      error: "Connect a Square account first",
      code: "square_not_connected",
    });
  }

  const normalizedCurrency = currency.toUpperCase();
  if (
    access.locationCurrency &&
    access.locationCurrency !== normalizedCurrency
  ) {
    return res.status(400).json({
      error: `This Square account charges in ${access.locationCurrency}`,
      code: "currency_mismatch",
    });
  }

  try {
    const link = await createSquarePaymentLink(access.accessToken, {
      // Stable per sale: retrying the same orderId returns the same link.
      idempotencyKey: `pos-${authResult.pubkey.slice(0, 16)}-${orderId}`,
      name:
        typeof title === "string" && title.trim()
          ? title.trim()
          : "In-person sale",
      amountSmallest,
      currency: normalizedCurrency,
      locationId: access.locationId,
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
    });
    return res.status(200).json({
      url: link.url,
      linkId: link.id,
      orderId: link.orderId,
    });
  } catch (error) {
    console.error("square pos-link failed:", error);
    return res
      .status(502)
      .json({ error: "Could not create the Square checkout link" });
  }
}
