import type { NextApiRequest, NextApiResponse } from "next";
import { getSquareConnection } from "@/utils/db/square-service";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  isSquareConfigured,
  getSquareApplicationId,
  getSquareEnvironment,
} from "@/utils/square/square-config";

// Buyer/guest-facing: reports whether a seller can take Square card payments and
// returns ONLY the public values the Web Payments SDK needs (application id,
// location id, environment, currency). Never returns access/refresh tokens.
// Unauthenticated like the Stripe seller-status; rate limited to bound abuse.
const RATE_LIMIT = { limit: 120, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "square-seller-status", RATE_LIMIT)))
    return;

  try {
    const { pubkey } = req.body;
    if (!pubkey || typeof pubkey !== "string") {
      return res.status(400).json({ error: "pubkey is required" });
    }

    // Fail closed when Square isn't configured for this deployment.
    if (!isSquareConfigured()) {
      return res
        .status(200)
        .json({
          configured: false,
          hasSquareAccount: false,
          chargesEnabled: false,
        });
    }

    const conn = await getSquareConnection(pubkey);
    if (!conn || conn.status !== "connected") {
      return res
        .status(200)
        .json({
          configured: true,
          hasSquareAccount: false,
          chargesEnabled: false,
        });
    }

    // Card charges need a resolved location + its settlement currency. If either
    // is missing, report the account present but card payments off (fail closed).
    const chargesEnabled = !!conn.locationId && !!conn.locationCurrency;

    return res.status(200).json({
      configured: true,
      hasSquareAccount: true,
      chargesEnabled,
      applicationId: getSquareApplicationId(),
      environment: getSquareEnvironment(),
      locationId: chargesEnabled ? conn.locationId : undefined,
      currency: chargesEnabled ? conn.locationCurrency : undefined,
    });
  } catch (error) {
    console.error("Seller Square status check error:", error);
    return res.status(500).json({
      error: "Failed to check seller status",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
