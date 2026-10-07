import { useEffect, useRef, useState } from "react";
import type {
  SellerOrder,
  SellerParcel,
  SellerSession,
  SellerShippingAddress,
} from "@self-sown/domain";
import type { SellerShippingLabel } from "@self-sown/api-client";
import {
  buySellerReturnLabel,
  loadSellerShipping,
} from "../lib/shipping-runtime";
import { getErrorMessage } from "../lib/error-utils";

interface Options {
  session: SellerSession;
  order: SellerOrder;
  from: SellerShippingAddress | null;
  parcel: SellerParcel | null;
}
export function useReturnLabels({ session, order, from, parcel }: Options) {
  const [settings, setSettings] = useState<Awaited<
    ReturnType<typeof loadSellerShipping>
  > | null>(null);
  const [labels, setLabels] = useState<SellerShippingLabel[]>([]);
  const [carriers, setCarriers] = useState<string[]>(["USPS"]);
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);

  async function refresh() {
    const current = generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await loadSellerShipping(session);
      if (current !== generation.current) return;
      setSettings(result);
      setLabels((existing) => {
        const fetched = result.labels.filter(
          (label) => label.isReturn && label.orderId === order.orderId
        );
        return [
          ...fetched,
          ...existing.filter(
            (label) =>
              !fetched.some(
                (candidate) => candidate.shipmentId === label.shipmentId
              )
          ),
        ];
      });
    } catch (cause) {
      if (current === generation.current)
        setError(
          getErrorMessage(cause, "Return shipping could not be loaded.")
        );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    generation.current += 1;
    setSettings(null);
    setLabels([]);
    setCarriers(["USPS"]);
    setBuying(false);
    busy.current = false;
    void refresh();
    return () => {
      generation.current += 1;
    };
    // Settings belong to this signed-in seller and this order only.
  }, [session, order.orderId]);

  const defaults = settings?.defaults;
  const issue = !settings
    ? ""
    : !settings.connection.configured || !settings.connection.connected
      ? "Connect your Shippo account in Shipping before issuing return labels."
      : !defaults?.fromStreet1 ||
          !defaults.fromCity ||
          !defaults.fromState ||
          !defaults.fromZip
        ? "Save a complete return address in Shipping before issuing return labels."
        : !from
          ? "This order does not contain a complete US shipping address."
          : !parcel
            ? "Add package weight to the matching listing before buying a return label."
            : "";
  const eligible =
    !order.pickupLocation &&
    (order.status === "shipped" || order.status === "completed");
  const ready = Boolean(
    settings &&
    !issue &&
    eligible &&
    carriers.length &&
    !loading &&
    !buying &&
    labels.length === 0
  );

  async function purchase() {
    if (!ready || busy.current || !from || !parcel) return;
    const current = generation.current;
    busy.current = true;
    setBuying(true);
    setError("");
    try {
      const label = await buySellerReturnLabel(session, {
        orderId: order.orderId,
        from,
        parcel,
        carriers,
      });
      if (current !== generation.current) return;
      setLabels((existing) => [
        label,
        ...existing.filter((item) => item.shipmentId !== label.shipmentId),
      ]);
      await refresh();
    } catch (cause) {
      if (current === generation.current)
        setError(
          getErrorMessage(cause, "The return label could not be purchased.")
        );
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setBuying(false);
      }
    }
  }
  return {
    defaults,
    labels,
    carriers,
    setCarriers,
    loading,
    buying,
    error,
    issue,
    ready,
    refresh,
    purchase,
  };
}
