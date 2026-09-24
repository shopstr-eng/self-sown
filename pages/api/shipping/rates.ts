import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { getRates } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import {
  getShippoAccessToken,
  getShippingDefaultsForPubkey,
  rememberShipmentOwner,
} from "@/utils/db/shipping-service";
import { getSellerOrderState } from "@/utils/db/db-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { isListedSeller } from "@/utils/shipping/shipment-owners";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import {
  MCP_REQUEST_PROOF_KIND,
  MCP_SIGNED_EVENT_HEADER,
  buildShippingRatesProof,
  isMcpRequestProofFresh,
  matchesMcpRequestProof,
  parseSignedEventHeader,
} from "@/utils/mcp/request-proof";
import { consumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import type { ParcelInput, ShippingAddressInput } from "@/utils/shipping/types";
import {
  normalizeSellerParcel,
  normalizeSellerShippingAddress,
} from "@milk-market/domain";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

const KNOWN_CARRIERS = new Set([
  "USPS",
  "UPS",
  "FEDEX",
  "DHL_EXPRESS",
  "CANADA_POST",
]);

interface RatesRequestBody {
  orderId?: string;
  from: ShippingAddressInput;
  to: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[];
  // Pubkey of the seller whose connected Shippo account should be used to
  // quote rates. Required for buyer-side (unsigned) checkout estimation; the
  // seller's own signed-event flow infers this from the event pubkey.
  sellerPubkey?: string;
}

interface MobileOrderRatesBody {
  orderId: string;
  to: Omit<ShippingAddressInput, "zip"> & { postalCode: string };
  parcel: ParcelInput;
}

const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
  if (!(await applyRateLimit(req, res, "shipping-rates", RATE_LIMIT))) return;
  if (!isShippoOAuthConfigured()) {
    return res
      .status(503)
      .json({ error: "Shipping provider not configured", skipped: true });
  }

  try {
    if (req.headers.authorization) {
      const auth = await verifyNip98Request(req, "POST", req.body);
      if (!auth.ok) return res.status(401).json({ error: auth.error });

      const { orderId, to, parcel } = (req.body ||
        {}) as Partial<MobileOrderRatesBody>;
      const normalizedTo = normalizeSellerShippingAddress(to);
      const normalizedParcel = normalizeSellerParcel(parcel || {});
      if (
        typeof orderId !== "string" ||
        !ORDER_ID.test(orderId) ||
        !normalizedTo ||
        !normalizedParcel
      ) {
        return res
          .status(400)
          .json({ error: "Invalid order shipping request" });
      }

      if (!(await isListedSeller(auth.pubkey))) {
        return res
          .status(403)
          .json({ error: "Only registered sellers may quote labels" });
      }
      if (!(await requireProEntitlement(auth.pubkey, res))) return;

      const order = await getSellerOrderState(orderId, auth.pubkey);
      if (!order) {
        return res
          .status(403)
          .json({ error: "Order does not belong to this seller" });
      }
      if (order.status !== "confirmed") {
        return res
          .status(409)
          .json({ error: "Only confirmed orders can be quoted" });
      }

      const defaults = await getShippingDefaultsForPubkey(auth.pubkey);
      if (
        !defaults?.fromStreet1 ||
        !defaults.fromCity ||
        !defaults.fromState ||
        !defaults.fromZip ||
        !defaults.fromCountry
      ) {
        return res
          .status(409)
          .json({ error: "Complete shipping defaults before quoting rates" });
      }
      const accessToken = await getShippoAccessToken(auth.pubkey);
      if (!accessToken) {
        return res
          .status(409)
          .json({ error: "Connect Shippo before quoting rates" });
      }

      const result = await getRates(accessToken, {
        from: {
          name: defaults.fromName || undefined,
          company: defaults.fromCompany || undefined,
          street1: defaults.fromStreet1,
          street2: defaults.fromStreet2 || undefined,
          city: defaults.fromCity,
          state: defaults.fromState,
          zip: defaults.fromZip,
          country: defaults.fromCountry,
          phone: defaults.fromPhone || undefined,
          email: defaults.fromEmail || undefined,
        },
        to: {
          name: normalizedTo.name,
          company: normalizedTo.company,
          street1: normalizedTo.street1,
          street2: normalizedTo.street2,
          city: normalizedTo.city,
          state: normalizedTo.state,
          zip: normalizedTo.postalCode,
          country: normalizedTo.country,
          phone: normalizedTo.phone,
          email: normalizedTo.email,
        },
        parcel: normalizedParcel,
        carriers: normalizeCarriers(defaults.preferredCarriers),
      });
      if (result.shipmentId) {
        await rememberShipmentOwner(result.shipmentId, auth.pubkey, orderId);
      }
      return res.status(200).json({ success: true, ...result });
    }

    const { orderId, from, to, parcel, carriers, sellerPubkey } = (req.body ||
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
      phone: from.phone,
      email: from.email,
    };

    // Resolve which seller's connected Shippo account to quote against.
    // Priority: a valid signed event (the seller quoting their own rates),
    // otherwise the explicit sellerPubkey from the body (buyer checkout).
    const signedHeader = req.headers[MCP_SIGNED_EVENT_HEADER];
    const signedHeaderValue = Array.isArray(signedHeader)
      ? signedHeader[0]
      : signedHeader;
    let ownerPubkey: string | null = null;
    let ownerProofEvent: ReturnType<typeof parseSignedEventHeader> = null;
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
          if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) {
            return res.status(400).json({ error: "Invalid order ID" });
          }
          if (
            !matchesMcpRequestProof(
              event,
              buildShippingRatesProof({
                pubkey: event.pubkey,
                orderId,
                from,
                to,
                parcel,
                carriers,
                sellerPubkey,
              })
            )
          ) {
            return res
              .status(401)
              .json({ error: "Signed event does not match request" });
          }
          ownerPubkey = event.pubkey;
          ownerProofEvent = event;
        }
      } catch {
        // Non-fatal: fall through to sellerPubkey resolution.
      }
    }
    // Pro gate: a seller quoting their own rates via a signed event must hold an
    // active Herd membership (this branch also registers shipment ownership for
    // label purchase). The buyer-side path (explicit sellerPubkey, unsigned)
    // stays open so guest checkout can always display live rates.
    if (ownerPubkey && !(await requireProEntitlement(ownerPubkey, res))) {
      return;
    }
    if (ownerPubkey) {
      const order = await getSellerOrderState(orderId!, ownerPubkey);
      if (!order) {
        return res
          .status(403)
          .json({ error: "Order does not belong to this seller" });
      }
      if (order.status !== "confirmed") {
        return res
          .status(409)
          .json({ error: "Only confirmed orders can be quoted" });
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
    if (
      ownerProofEvent &&
      !(await consumeSignedRequestProof(
        ownerProofEvent,
        "shipping_quote_rates"
      ))
    ) {
      return res
        .status(401)
        .json({ error: "Signed event has already been used." });
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
        company: to.company,
        phone: to.phone,
        email: to.email,
      },
      parcel,
      carriers: normalizeCarriers(carriers),
    });

    // Ownership registration: if the seller quoted their own rates with a
    // valid signed event, record them as the owner of this shipment so
    // /api/shipping/buy-label can authorize the purchase.
    if (ownerPubkey && result.shipmentId) {
      await rememberShipmentOwner(result.shipmentId, ownerPubkey, orderId);
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
