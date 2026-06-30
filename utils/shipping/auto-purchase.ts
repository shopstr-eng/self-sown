// Automatic Shippo label purchase for PAID orders.
//
// When a seller has auto-purchase enabled (the default), a paid card (Stripe)
// or agent (MCP) order triggers a server-side purchase of the cheapest
// preferred-carrier label, billed to the SELLER's own connected Shippo account
// (never buyer funds). When disabled, nothing happens here and the seller buys
// labels manually from the orders dashboard.
//
// Money-safety invariants:
//   - The label is always bought on the seller's OWN Shippo OAuth token.
//   - A per-(seller, order) atomic DB claim is taken BEFORE any Shippo call, so
//     retries, webhook replays, concurrent web line POSTs, and multiple server
//     instances can never buy more than one label for the same order.
//   - Every path is wrapped so this NEVER throws to its caller — it must never
//     block an order, a payment settlement, or an HTTP 200.

import type { NostrEvent } from "@/utils/types/types";
import type { ShippingAddressInput } from "@/utils/shipping/types";
import { buyLabel, getRates } from "@/utils/shipping/shippo";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import parseTags from "@/utils/parsers/product-parser-functions";
import { fetchProductByIdFromDb } from "@/utils/db/db-service";
import {
  claimAutoLabelPurchase,
  countOutboundLabelsForOrder,
  getShippingDefaultsForPubkey,
  getShippoAccessToken,
  insertShippingLabel,
  markAutoLabelPurchased,
  releaseAutoLabelClaim,
} from "@/utils/db/shipping-service";

export interface AutoLabelResult {
  purchased: boolean;
  // Why the purchase did not happen (for logging only; never surfaced to a
  // buyer). `error` means a failure occurred; everything else is a benign skip.
  reason?:
    | "disabled"
    | "not-pro"
    | "no-shippo"
    | "provider-unconfigured"
    | "ineligible"
    | "already-bought"
    | "claimed-by-other"
    | "no-rates"
    | "error";
  labelId?: number | null;
}

interface RunAutoLabelArgs {
  sellerPubkey: string;
  orderId: string;
  // Stripe-bound idempotency ref for the dedupe claim. The web card POST is
  // unauthenticated and carries a client-GENERATED orderId, so it MUST pass the
  // verified PaymentIntent id here — otherwise one settled PI could be replayed
  // with fresh orderIds to buy unlimited seller-billed labels. MCP orders have a
  // server-side orderId and omit this (the claim falls back to orderId).
  claimRef?: string | null;
  // The product event to ship. Pass `productEvent` directly when the caller
  // already has it, or `productId` (a product EVENT id) to have it fetched.
  productEvent?: NostrEvent | null;
  productId?: string | null;
  toAddress: ShippingAddressInput;
}

function isUsCountry(country?: string | null): boolean {
  const c = (country || "").trim().toUpperCase();
  return c === "US" || c === "USA" || c === "UNITED STATES";
}

// One auto-label per (seller, order). MCP orders are single-product, and web
// checkout groups a seller's products into one shipment, so this matches the
// manual dashboard's one-label-per-order granularity.
function buildClaimKey(
  sellerPubkey: string,
  orderId: string,
  claimRef?: string | null
): string {
  return `outbound:${sellerPubkey}:${claimRef || orderId}`;
}

/**
 * Core auto-purchase routine shared by the card (web) and agent (MCP) paths.
 * Resolves the seller's settings, verifies eligibility, atomically claims the
 * order, then buys the cheapest preferred-carrier label on the seller's Shippo
 * account. Returns a structured result and NEVER throws.
 */
export async function runAutoLabelPurchase(
  args: RunAutoLabelArgs
): Promise<AutoLabelResult> {
  const { sellerPubkey, orderId, toAddress } = args;
  try {
    if (!sellerPubkey || !orderId) return { purchased: false, reason: "error" };
    if (!isShippoOAuthConfigured()) {
      return { purchased: false, reason: "provider-unconfigured" };
    }

    // 1) Seller toggle. Default ON: only an explicit `false` disables it.
    const defaults = await getShippingDefaultsForPubkey(sellerPubkey);
    if (defaults && defaults.autoPurchaseLabels === false) {
      return { purchased: false, reason: "disabled" };
    }

    // 2) Pro gate: automatic labels are a Herd feature. Mirrors the manual
    //    buy-label endpoint's server-side entitlement check.
    if (!(await isPubkeyProEntitled(sellerPubkey))) {
      return { purchased: false, reason: "not-pro" };
    }

    // 3) The seller must have connected their own Shippo account; the label is
    //    billed there, never to platform/buyer funds.
    const accessToken = await getShippoAccessToken(sellerPubkey);
    if (!accessToken) return { purchased: false, reason: "no-shippo" };

    // 4) Resolve the product event (parcel + ship-from live in its tags).
    const productEvent =
      args.productEvent ||
      (args.productId ? await fetchProductByIdFromDb(args.productId) : null);
    if (!productEvent) return { purchased: false, reason: "ineligible" };
    // The product must belong to the seller we are charging.
    if (productEvent.pubkey !== sellerPubkey) {
      return { purchased: false, reason: "ineligible" };
    }

    const tags = parseTags(productEvent);
    const shipFromZip = tags?.shipFromZip?.trim();
    const weightOz = tags?.packageWeightOz || 0;

    // 5) Eligibility — mirror the manual dashboard's canBuyLabelForOrder: US
    //    destination, a ship-from ZIP, a positive parcel weight, and a complete
    //    destination address. Anything else (pickup, international, missing
    //    parcel) is a benign skip — the seller can still buy manually.
    if (
      !isUsCountry(toAddress.country) ||
      !shipFromZip ||
      weightOz <= 0 ||
      !toAddress.street1 ||
      !toAddress.city ||
      !toAddress.state ||
      !toAddress.zip
    ) {
      return { purchased: false, reason: "ineligible" };
    }

    // 6) Belt-and-suspenders: if a non-return label already exists for this
    //    seller + order (bought manually or by a prior auto-purchase), do not
    //    buy another.
    if ((await countOutboundLabelsForOrder(sellerPubkey, orderId)) > 0) {
      return { purchased: false, reason: "already-bought" };
    }

    // 7) Atomic claim BEFORE any Shippo call. The single winner proceeds; all
    //    duplicates/retries/concurrent callers skip.
    const claimKey = buildClaimKey(sellerPubkey, orderId, args.claimRef);
    if (!(await claimAutoLabelPurchase(claimKey, sellerPubkey, orderId))) {
      return { purchased: false, reason: "claimed-by-other" };
    }

    try {
      const carriers =
        defaults && defaults.preferredCarriers.length > 0
          ? defaults.preferredCarriers
          : ["USPS"];

      // Mirror the manual outbound flow's from-address: a minimal ship-from
      // (ZIP + country) is sufficient for domestic rates/labels.
      const from: ShippingAddressInput = {
        street1: "Unknown",
        city: "Unknown",
        state: "",
        zip: shipFromZip,
        country: (tags?.shipFromCountry || "US").toUpperCase(),
      };
      const parcel = {
        weightOz,
        lengthIn: tags?.packageLengthIn,
        widthIn: tags?.packageWidthIn,
        heightIn: tags?.packageHeightIn,
      };

      const rates = await getRates(accessToken, {
        from,
        to: {
          name: toAddress.name,
          street1: toAddress.street1,
          street2: toAddress.street2,
          city: toAddress.city,
          state: toAddress.state,
          zip: toAddress.zip,
          country: toAddress.country,
        },
        parcel,
        carriers,
      });

      const cheapest = rates.cheapest;
      if (!cheapest) {
        // No rate to buy — release so a manual retry (or later attempt) works.
        await releaseAutoLabelClaim(claimKey);
        return { purchased: false, reason: "no-rates" };
      }

      const label = await buyLabel(accessToken, {
        shipmentId: rates.shipmentId,
        rateId: cheapest.id,
      });

      // Purchase succeeded — promote the claim to the permanent 'purchased'
      // marker so it can never be auto-bought again.
      await markAutoLabelPurchased(claimKey, label.shipmentId);

      let labelId: number | null = null;
      try {
        const rec = await insertShippingLabel({
          pubkey: sellerPubkey,
          shipmentId: label.shipmentId,
          orderId,
          trackingCode: label.trackingCode || null,
          trackingUrl: label.trackingUrl ?? null,
          labelUrl: label.labelUrl,
          labelFormat: label.labelFormat,
          rateUsd: label.rate,
          currency: label.currency,
          carrier: label.carrier,
          service: label.service,
          isReturn: false,
          fromSummary: `ZIP ${shipFromZip}`,
          toSummary: `${toAddress.street1}, ${toAddress.city}, ${toAddress.state} ${toAddress.zip}`,
          parcelSummary: `${weightOz} oz (auto)`,
        });
        labelId = rec.id;
      } catch (dbErr) {
        // The seller was charged by Shippo but the history insert failed. Log
        // loudly for reconciliation; the claim stays 'purchased' so we never
        // double-buy. The seller still has the label in their Shippo account.
        console.error(
          "CRITICAL: auto-purchased Shippo label but history insert failed",
          { sellerPubkey, orderId, shipmentId: label.shipmentId, dbErr }
        );
      }

      return { purchased: true, labelId };
    } catch (buyErr) {
      // Failed before/at Shippo — release the claim so a later attempt or a
      // manual purchase can proceed.
      await releaseAutoLabelClaim(claimKey);
      console.error("Auto label purchase failed:", {
        sellerPubkey,
        orderId,
        error: buyErr instanceof Error ? buyErr.message : buyErr,
      });
      return { purchased: false, reason: "error" };
    }
  } catch (err) {
    // Defensive outer catch: this function must never throw to its caller.
    console.error("runAutoLabelPurchase unexpected error:", {
      sellerPubkey,
      orderId,
      error: err instanceof Error ? err.message : err,
    });
    return { purchased: false, reason: "error" };
  }
}

// MCP shipping_address shape (as stored on mcp_orders.shipping_address):
//   { name, address, unit?, city, postalCode, stateProvince, country }
interface McpShippingAddress {
  name?: string;
  address?: string;
  unit?: string;
  city?: string;
  postalCode?: string;
  stateProvince?: string;
  country?: string;
}

/**
 * Fire auto-purchase for a PAID MCP/agent order. Loads the order + product
 * server-side and normalizes the stored shipping address. Best-effort and
 * never throws — safe to call (unawaited) from any paid-marking seam.
 */
export async function autoPurchaseForMcpOrder(
  orderId: string
): Promise<AutoLabelResult> {
  try {
    // Imported lazily to avoid pulling the MCP tools graph into modules that
    // only need the web path.
    const { getMcpOrder } = await import("@/mcp/tools/purchase-tools");
    const order = await getMcpOrder(orderId);
    if (!order) return { purchased: false, reason: "error" };
    if (order.payment_status !== "paid") {
      return { purchased: false, reason: "ineligible" };
    }

    const addr = (order.shipping_address || {}) as McpShippingAddress;
    const toAddress: ShippingAddressInput = {
      name: addr.name || undefined,
      street1: addr.address || "",
      street2: addr.unit || undefined,
      city: addr.city || "",
      state: addr.stateProvince || "",
      zip: addr.postalCode || "",
      country: addr.country || "",
      email: order.buyer_email || undefined,
    };

    return await runAutoLabelPurchase({
      sellerPubkey: order.seller_pubkey,
      orderId: order.order_id,
      productId: order.product_id,
      toAddress,
    });
  } catch (err) {
    console.error("autoPurchaseForMcpOrder unexpected error:", {
      orderId,
      error: err instanceof Error ? err.message : err,
    });
    return { purchased: false, reason: "error" };
  }
}
