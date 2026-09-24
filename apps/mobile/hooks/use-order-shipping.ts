import { useEffect, useRef, useState } from "react";

import {
  createSellerListingDraftFromEvent,
  normalizeSellerParcel,
  parseSellerOrderAddress,
  parseSellerProductAddress,
  type NostrEventRecord,
  type SellerOrder,
  type SellerSession,
} from "@milk-market/domain";
import type {
  SellerShippingLabel,
  SellerShippingRate,
} from "@milk-market/api-client";

import { getErrorMessage } from "@/lib/error-utils";
import {
  buySellerOrderLabel,
  listSellerOrderLabels,
  quoteSellerOrderShipping,
} from "@/lib/shipping-runtime";

interface TrackingDetails {
  carrier: string;
  tracking: string;
  purchased: boolean;
}

interface UseOrderShippingOptions {
  session: SellerSession;
  order: SellerOrder;
  listingEvents?: NostrEventRecord[];
  onTrackingDetails(details: TrackingDetails): void;
}

export function useOrderShipping({
  session,
  order,
  listingEvents,
  onTrackingDetails,
}: UseOrderShippingOptions) {
  const trackingDetailsHandler = useRef(onTrackingDetails);
  const [rates, setRates] = useState<SellerShippingRate[]>([]);
  const [selectedRateId, setSelectedRateId] = useState("");
  const [labels, setLabels] = useState<SellerShippingLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  trackingDetailsHandler.current = onTrackingDetails;

  useEffect(() => {
    setRates([]);
    setSelectedRateId("");
    setLabels([]);
    setError("");

    let active = true;
    void listSellerOrderLabels(session, order.orderId)
      .then((result) => {
        if (!active) return;
        setLabels(result);
        const latest = result[0];
        if (latest) {
          trackingDetailsHandler.current({
            carrier: latest.carrier ?? "",
            tracking: latest.trackingCode ?? "",
            purchased: false,
          });
        }
      })
      .catch(() => {
        if (active) setError("Purchased labels could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, [order.orderId, session]);

  const shippingAddress = order.address
    ? parseSellerOrderAddress(order.address)
    : null;
  const productCoordinate = parseSellerProductAddress(
    order.productAddress,
    session.pubkey
  );
  const listingEvent = productCoordinate
    ? listingEvents?.find(
        (event) =>
          event.pubkey === session.pubkey &&
          event.tags.some(
            (tag) => tag[0] === "d" && tag[1] === productCoordinate.dTag
          )
      )
    : undefined;
  const listingDraft = listingEvent
    ? createSellerListingDraftFromEvent(listingEvent)
    : null;
  const parcel = listingDraft
    ? normalizeSellerParcel({
        weightOz: listingDraft.packageWeightOz,
        lengthIn: listingDraft.packageLengthIn,
        widthIn: listingDraft.packageWidthIn,
        heightIn: listingDraft.packageHeightIn,
      })
    : null;

  const quoteRates = async () => {
    if (!shippingAddress || !parcel) return;
    setLoading(true);
    setError("");
    try {
      const result = await quoteSellerOrderShipping(session, {
        orderId: order.orderId,
        to: shippingAddress,
        parcel,
      });
      setRates(result.rates);
      setSelectedRateId(result.rates[0]?.id ?? "");
      if (result.rates.length === 0) {
        setError("No carrier rates were returned.");
      }
    } catch (cause) {
      setError(getErrorMessage(cause, "Carrier rates could not be loaded."));
    } finally {
      setLoading(false);
    }
  };

  const purchaseLabel = async () => {
    const rate = rates.find((candidate) => candidate.id === selectedRateId);
    if (!rate) return;
    setLoading(true);
    setError("");
    try {
      const label = await buySellerOrderLabel(session, {
        orderId: order.orderId,
        shipmentId: rate.shipmentId,
        rateId: rate.id,
      });
      setLabels([label]);
      setRates([]);
      trackingDetailsHandler.current({
        carrier: label.carrier ?? "",
        tracking: label.trackingCode ?? "",
        purchased: true,
      });
    } catch (cause) {
      setError(
        getErrorMessage(cause, "The shipping label could not be purchased.")
      );
    } finally {
      setLoading(false);
    }
  };

  return {
    shippingAddress,
    parcel,
    rates,
    selectedRateId,
    setSelectedRateId,
    labels,
    loading,
    error,
    quoteRates,
    purchaseLabel,
  };
}
