import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { getRates } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import {
  getShippoAccessToken,
  rememberShipmentOwner,
} from "@/utils/db/shipping-service";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  isMcpRequestProofFresh,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import type { ParcelInput, ShippingAddressInput } from "@/utils/shipping/types";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

const KNOWN_CARRIERS = new Set([
  "USPS",
  "UPS",
  "FEDEX",
  "DHL_EXPRESS",
  "CANADA_POST",
]);

interface RatesRequestBody {
  from: ShippingAddressInput;
  to: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[];
  // Pubkey of the seller whose connected Shippo account should be used to
  // quote rates. Required for buyer-side (unsigned) checkout estimation; the
  // seller's own signed-event flow infers this from the event pubkey.
  sellerPubkey?: string;
}

function normalizeCarriers(input: string[] | undefined): string[] {
  const list = (input || ["USPS"])
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const filtered = list.filter((c) => KNOWN_CARRIERS.has(c));
  return filtered.length > 0 ? filtered : ["USPS"];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "shipping-rates", RATE_LIMIT)) return;
  if (!isShippoOAuthConfigured()) {
    return res
      .status(503)
      .json({ error: "Shipping provider not configured", skipped: true });
  }

  try {
    const { from, to, parcel, carriers, sellerPubkey } = (req.body ||
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

    // Resolve which seller's connected Shippo account to quote against.
    // Priority: a valid signed event (the seller quoting their own rates),
    // otherwise the explicit sellerPubkey from the body (buyer checkout).
    const signedHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
    const signedHeaderValue = Array.isArray(signedHeader)
      ? signedHeader[0]
      : signedHeader;
    let ownerPubkey: string | null = null;
    if (signedHeaderValue) {
      try {
        const event = parseSignedEventHeader(signedHeaderValue);
        if (
          event &&
          event.kind === MCP_REQUEST_PROOF_KIND &&
          verifyEvent(event) &&
          isMcpRequestProofFresh(event) &&
          (await isListedSeller(event.pubkey))
        ) {
          ownerPubkey = event.pubkey;
        }
      } catch {
        // Non-fatal: fall through to sellerPubkey resolution.
      }
    }
    const resolvedSeller = ownerPubkey || sellerPubkey || null;
    if (!resolvedSeller) {
      return res.status(200).json({
        success: false,
        rates: [],
        cheapest: null,
        error: "No seller specified for shipping rates",
      });
    }
    const accessToken = await getShippoAccessToken(resolvedSeller);
    if (!accessToken) {
      return res.status(200).json({
        success: false,
        rates: [],
        cheapest: null,
        error: "Seller has not connected a Shippo account",
      });
    }

    const result = await getRates(accessToken, {
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
      carriers: normalizeCarriers(carriers),
    });

    // Ownership registration: if the seller quoted their own rates with a
    // valid signed event, record them as the owner of this shipment so
    // /api/shipping/buy-label can authorize the purchase.
    if (ownerPubkey && result.shipmentId) {
      await rememberShipmentOwner(result.shipmentId, ownerPubkey);
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
