import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { isShippoConfigured, verifyAddress } from "@/utils/shipping/shippo";
import type { ShippingAddressInput } from "@/utils/shipping/types";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-verify", RATE_LIMIT)) return;
  if (!isShippoConfigured()) {
    return res
      .status(503)
      .json({ error: "Shipping provider not configured", skipped: true });
  }

  try {
    const body = req.body as Partial<ShippingAddressInput> | undefined;
    if (
      !body ||
      !body.street1 ||
      !body.city ||
      !body.state ||
      !body.zip ||
      !body.country
    ) {
      return res.status(400).json({
        error:
          "Missing required address fields (street1, city, state, zip, country)",
      });
    }

    const verified = await verifyAddress({
      street1: body.street1,
      street2: body.street2,
      city: body.city,
      state: body.state,
      zip: body.zip,
      country: body.country,
      name: body.name,
      phone: body.phone,
      email: body.email,
    });

    return res.status(200).json({ success: true, ...verified });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.warn("Address verification failed:", message);
    // Don't surface as 500 — soft failure so checkout never blocks.
    return res.status(200).json({
      success: false,
      valid: false,
      messages: [{ source: "internal", text: message }],
    });
  }
}
