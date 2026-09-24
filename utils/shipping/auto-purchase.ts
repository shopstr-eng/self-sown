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
import {
  buyLabel,
  findSuccessfulTransactionForShipment,
  getRates,
} from "@/utils/shipping/shippo";
import {
  buildLabelReconcileToken,
  resolveOrderLabelClaimConflict,
} from "@/utils/shipping/claim-reconcile";
import { isShippoOAuthConfigured } from "@/utils/shipping/shippo-oauth";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import parseTags from "@/utils/parsers/product-parser-functions";
import { fetchProductByIdFromDb } from "@/utils/db/db-service";
import {
  attachShipmentToClaim,
  claimAutoLabelPurchase,
  countOutboundLabelsForOrder,
  getAutoLabelClaim,
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
  // server-side orderId and omit this (the per-order claim alone guards them).
  claimRef?: string | null;
  // The product event to ship. Pass `productEvent` directly when the caller
  // already has it, or `productId` (a product EVENT id) to have it fetched.
  productEvent?: NostrEvent | null;
  productId?: string | null;
  toAddress: ShippingAddressInput;
  // Deliberate seller/agent triggers mirror the manual dashboard buy button
  // and ignore the auto-purchase toggle (which only governs
  // payment-triggered buys).
  bypassAutoToggle?: boolean;
}

function isUsCountry(country?: string | null): boolean {
  const c = (country || "").trim().toUpperCase();
  return c === "US" || c === "USA" || c === "UNITED STATES";
}

// One outbound label per (seller, order) — and this exact key shape is shared
// with the manual dashboard purchase route, so no path combination (webhook
// replay, agent retry, dashboard click) can ever buy two labels for an order.
// MCP orders are single-product, and web checkout groups a seller's products
// into one shipment, so this matches one-label-per-order granularity.
function buildClaimKey(sellerPubkey: string, orderId: string): string {
  return `outbound:${sellerPubkey}:${orderId}`;
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
    //    Deliberate triggers (manual dashboard, seller's own agent) skip this.
    const defaults = await getShippingDefaultsForPubkey(sellerPubkey);
    if (
      !args.bypassAutoToggle &&
      defaults &&
      defaults.autoPurchaseLabels === false
    ) {
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

    // 7) Atomic claims BEFORE any Shippo call. Two orthogonal guards:
    //    - a PAYMENT-bound claim (when claimRef carries a verified payment id)
    //      stops webhook replays carrying a fresh client orderId per attempt;
    //    - an ORDER-bound claim — shared with the manual dashboard route —
    //      stops agent/dashboard/webhook path combinations.
    //    Either conflict is reconciled against Shippo before deciding: a
    //    lost-but-successful charge resolves to already-bought; a stale claim
    //    with NO Shippo transaction is released and this attempt proceeds.
    const claimOrReconcile = async (
      key: string
    ): Promise<"won" | "already-bought" | "lost"> => {
      if (await claimAutoLabelPurchase(key, sellerPubkey, orderId)) {
        return "won";
      }
      const resolution = await resolveOrderLabelClaimConflict({
        accessToken,
        claimKey: key,
        pubkey: sellerPubkey,
        orderId,
      });
      if (resolution === "already-bought") return "already-bought";
      if (
        resolution === "retry-safe" &&
        (await claimAutoLabelPurchase(key, sellerPubkey, orderId))
      ) {
        return "won";
      }
      return "lost";
    };

    let paymentClaimKey: string | null = null;
    if (args.claimRef) {
      paymentClaimKey = `payment:${sellerPubkey}:${args.claimRef}`;
      const paymentClaimResult = await claimOrReconcile(paymentClaimKey);
      if (paymentClaimResult === "already-bought") {
        return { purchased: false, reason: "already-bought" };
      }
      if (paymentClaimResult === "lost") {
        return { purchased: false, reason: "claimed-by-other" };
      }
    }

    const claimKey = buildClaimKey(sellerPubkey, orderId);
    const orderClaimResult = await claimOrReconcile(claimKey);
    if (orderClaimResult !== "won") {
      // This attempt charged nothing; free the payment claim it just took so
      // a later legitimate attempt isn't blocked by it.
      if (paymentClaimKey) await releaseAutoLabelClaim(paymentClaimKey);
      return {
        purchased: false,
        reason:
          orderClaimResult === "already-bought"
            ? "already-bought"
            : "claimed-by-other",
      };
    }

    // Rate fetching is PRE-charge: a failure here definitely means Shippo was
    // never asked to charge, so the claims are safe to release for a retry.
    let rates;
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

      rates = await getRates(accessToken, {
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
    } catch (rateErr) {
      console.error("Auto label rate fetch failed (pre-charge):", rateErr);
      await releaseAutoLabelClaim(claimKey).catch(() => undefined);
      if (paymentClaimKey) {
        await releaseAutoLabelClaim(paymentClaimKey).catch(() => undefined);
      }
      return { purchased: false, reason: "error" };
    }

    const cheapest = rates.cheapest;
    if (!cheapest) {
      // No rate to buy — release so a manual retry (or later attempt) works.
      await releaseAutoLabelClaim(claimKey);
      if (paymentClaimKey) await releaseAutoLabelClaim(paymentClaimKey);
      return { purchased: false, reason: "no-rates" };
    }

    // One fixed-length reconciliation token for this attempt, persisted on
    // BOTH claims and stamped into the Shippo transaction metadata — either
    // claim can later reconcile a lost charge. (Raw claim keys exceed
    // Shippo's 100-char metadata limit.)
    const reconcileToken = buildLabelReconcileToken(claimKey);

    // Attach the shipment id to the claims BEFORE the non-idempotent charge.
    // Without this handle an ambiguous charge can never be reconciled, so a
    // failure here STOPS the purchase — nothing is charged unguarded.
    const ratesShipmentId = rates.shipmentId;
    try {
      const attachedOrder = await attachShipmentToClaim(
        claimKey,
        ratesShipmentId,
        reconcileToken
      );
      const attachedPayment = paymentClaimKey
        ? await attachShipmentToClaim(
            paymentClaimKey,
            ratesShipmentId,
            reconcileToken
          )
        : true;
      if (!attachedOrder || !attachedPayment) {
        throw new Error("claim row missing or no longer pending");
      }
    } catch (attachErr) {
      console.error(
        "CRITICAL: could not attach shipment to label claim; purchase NOT attempted (no charge was made):",
        { claimKey, attachErr }
      );
      await releaseAutoLabelClaim(claimKey).catch(() => undefined);
      if (paymentClaimKey) {
        await releaseAutoLabelClaim(paymentClaimKey).catch(() => undefined);
      }
      return { purchased: false, reason: "error" };
    }

    try {
      const label = await buyLabel(accessToken, {
        shipmentId: ratesShipmentId,
        rateId: cheapest.id,
        // Stamped onto the Shippo transaction so a lost response can be
        // reconciled (transactions carry no shipment id).
        metadata: reconcileToken,
      });

      // Purchase succeeded — promote the claims to permanent 'purchased'
      // markers so neither this order nor this payment can ever buy again.
      await markAutoLabelPurchased(claimKey, label.shipmentId);
      if (paymentClaimKey) {
        try {
          await markAutoLabelPurchased(paymentClaimKey, label.shipmentId);
        } catch (markErr) {
          console.error(
            "CRITICAL: label purchased but payment claim not marked:",
            { paymentClaimKey, markErr }
          );
        }
      }

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
      // The Shippo transaction POST is NOT idempotent: a throw here is
      // ambiguous (a timeout after Shippo accepted the charge looks exactly
      // like a pre-charge failure, and a DB error marking the claim
      // 'purchased' also lands here). Before reporting failure, reconcile
      // against Shippo's transaction list: if the charge DID land, record it
      // and mark the claim purchased so no path ever buys a second label.
      try {
        const shipmentId =
          ratesShipmentId ||
          (await getAutoLabelClaim(claimKey))?.shipmentId ||
          null;
        if (shipmentId) {
          // In this catch we only care whether a charge EXISTS; coverage and
          // in-flight states only gate claim RELEASE (claim-reconcile.ts) — a
          // held claim is always the fail-closed outcome here.
          const lookup = await findSuccessfulTransactionForShipment({
            accessToken,
            shipmentId,
            reconcileToken,
            sinceMs: Date.now() - 5 * 60 * 1000,
          });
          const label = lookup.label;
          if (label) {
            await markAutoLabelPurchased(claimKey, shipmentId);
            if (paymentClaimKey) {
              try {
                await markAutoLabelPurchased(paymentClaimKey, shipmentId);
              } catch (markErr) {
                console.error(
                  "CRITICAL: reconciled charge but payment claim not marked:",
                  { paymentClaimKey, markErr }
                );
              }
            }
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
              });
              return { purchased: true, labelId: rec.id };
            } catch (dbErr) {
              console.error(
                "CRITICAL: reconciled a charged label but its history insert failed:",
                { claimKey, shipmentId, dbErr }
              );
              return { purchased: true, labelId: null };
            }
          }
        }
      } catch {
        // Reconciliation itself unavailable — fall through and hold the
        // claim; the next attempt's conflict path retries reconciliation.
      }
      // No successful transaction found: hold the claim (never released here,
      // so a retry can't double-charge). The claim's attached shipment lets
      // the next attempt re-run this reconciliation.
      console.error(
        "CRITICAL: auto label purchase failed ambiguously; claim held pending Shippo reconciliation:",
        {
          sellerPubkey,
          orderId,
          error: buyErr instanceof Error ? buyErr.message : buyErr,
        }
      );
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
  orderId: string,
  opts?: { bypassAutoToggle?: boolean }
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
      bypassAutoToggle: opts?.bypassAutoToggle,
    });
  } catch (err) {
    console.error("autoPurchaseForMcpOrder unexpected error:", {
      orderId,
      error: err instanceof Error ? err.message : err,
    });
    return { purchased: false, reason: "error" };
  }
}
