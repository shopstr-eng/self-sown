import type { NextApiRequest, NextApiResponse } from "next";
import {
  getSquareConnection,
  updateSquareLocationCountry,
} from "@/utils/db/square-service";
import {
  getValidSquareAccessToken,
  fetchSquareLocations,
  pickPrimaryLocation,
} from "@/utils/square/square-api";
import { applyRateLimit } from "@/utils/rate-limit";
import { activateSquareApplePayDomain } from "@/utils/square/apple-pay";
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
      return res.status(200).json({
        configured: false,
        hasSquareAccount: false,
        chargesEnabled: false,
      });
    }

    const conn = await getSquareConnection(pubkey);
    if (!conn || conn.status !== "connected") {
      return res.status(200).json({
        configured: true,
        hasSquareAccount: false,
        chargesEnabled: false,
      });
    }

    // Card charges need a resolved location + its settlement currency. If either
    // is missing, report the account present but card payments off (fail closed).
    const chargesEnabled = !!conn.locationId && !!conn.locationCurrency;

    // Best-effort Apple Pay domain activation on the PRE-SDK path: this route
    // runs before the Web Payments SDK initializes, so activating here is what
    // lets a first-ever checkout on a verified custom domain show the Apple Pay
    // button (payments.applePay() hides it on unactivated domains, and the
    // create-payment route is only reachable after the SDK tokenizes). Awaited
    // but bounded (abort timeout + single-flight inside); it swallows its own
    // errors and never blocks or fails the status check.
    if (chargesEnabled) {
      try {
        await activateSquareApplePayDomain(req.headers?.host, pubkey);
      } catch (e) {
        // activateSquareApplePayDomain already swallows its own errors; this
        // is belt-and-braces so activation can never break the status check.
        console.warn("Square Apple Pay activation failed (non-fatal):", e);
      }
    }

    // Apple Pay's payment request needs the merchant's countryCode. Connections
    // made before the column existed have none — backfill once from the
    // locations API (preferring the stored location) and persist. Non-fatal:
    // card checkout doesn't need it, Apple Pay just stays hidden until set.
    let countryCode = conn.locationCountry;
    if (chargesEnabled && !countryCode) {
      try {
        const access = await getValidSquareAccessToken(pubkey);
        if (access) {
          const locations = await fetchSquareLocations(access.accessToken);
          const match =
            locations.find((l) => l.id === conn.locationId) ??
            pickPrimaryLocation(locations);
          if (match?.country) {
            countryCode = match.country;
            await updateSquareLocationCountry(pubkey, match.country);
          }
        }
      } catch (e) {
        console.warn("Square country backfill failed (non-fatal):", e);
      }
    }

    return res.status(200).json({
      configured: true,
      hasSquareAccount: true,
      chargesEnabled,
      applicationId: getSquareApplicationId(),
      environment: getSquareEnvironment(),
      locationId: chargesEnabled ? conn.locationId : undefined,
      currency: chargesEnabled ? conn.locationCurrency : undefined,
      countryCode: chargesEnabled ? (countryCode ?? undefined) : undefined,
    });
  } catch (error) {
    console.error("Seller Square status check error:", error);
    return res.status(500).json({
      error: "Failed to check seller status",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
