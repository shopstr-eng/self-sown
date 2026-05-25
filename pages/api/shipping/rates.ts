import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { getRates, isEasyPostConfigured } from "@/utils/shipping/easypost";
import {
  isListedSeller,
  rememberShipmentOwner,
} from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import type { ParcelInput, ShippingAddressInput } from "@/utils/shipping/types";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

interface RatesRequestBody {
  from: ShippingAddressInput;
  to: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-rates", RATE_LIMIT)) return;
  if (!isEasyPostConfigured()) {
    return res
      .status(503)
      .json({ error: "Shipping provider not configured", skipped: true });
  }

  try {
    const { from, to, parcel, carriers } = (req.body ||
      {}) as Partial<RatesRequestBody>;

    if (
      !from?.zip ||
      !from?.country ||
      !to?.zip ||
      !to?.country ||
      !to.street1 ||
      !to.city ||
      !to.state
    ) {
      return res.status(400).json({
        error:
          "from.zip+country and to.{street1,city,state,zip,country} are required",
      });
    }
    if (!parcel || !parcel.weightOz || parcel.weightOz <= 0) {
      return res
        .status(400)
        .json({ error: "parcel.weightOz (oz) is required and must be > 0" });
    }

    const filled: ShippingAddressInput = {
      street1: from.street1 || "Unknown",
      street2: from.street2,
      city: from.city || "Unknown",
      state: from.state || "",
      zip: from.zip,
      country: from.country,
      name: from.name,
      company: from.company,
    };

    const result = await getRates({
      from: filled,
      to: {
        street1: to.street1,
        street2: to.street2,
        city: to.city,
        state: to.state,
        zip: to.zip,
        country: to.country,
        name: to.name,
      },
      parcel,
      carriers,
    });

    // Optional ownership registration: if caller supplied a signed event,
    // record the requester pubkey as the owner of this shipment so that
    // /api/shipping/buy-label can authorize purchase. Cart-side rate
    // queries omit the header (rates are public).
    const signedHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
    const signedHeaderValue = Array.isArray(signedHeader)
      ? signedHeader[0]
      : signedHeader;
    if (signedHeaderValue && result.shipmentId) {
      try {
        const event = parseSignedEventHeader(signedHeaderValue);
        if (
          event &&
          event.kind === MCP_REQUEST_PROOF_KIND &&
          verifyEvent(event) &&
          isMcpRequestProofFresh(event) &&
          (await isListedSeller(event.pubkey))
        ) {
          rememberShipmentOwner(result.shipmentId, event.pubkey);
        }
      } catch {
        // Non-fatal: ownership simply won't be registered, and buy-label
        // will reject. Don't block public rate display.
      }
    }

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.warn("Shipping rates lookup failed:", message);
    return res.status(200).json({
      success: false,
      rates: [],
      cheapest: null,
      error: message,
    });
  }
}
