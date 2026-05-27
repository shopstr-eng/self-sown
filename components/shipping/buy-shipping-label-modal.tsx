import { useEffect, useState, useContext, useMemo } from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import {
  MCP_SIGNED_EVENT_HEADER,
  buildMcpRequestProofTemplate,
  buildShippingBuyLabelProof,
} from "@/utils/mcp/request-proof";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  SUPPORTED_CARRIERS,
  ShippoDefaults,
  ShippoSpend,
  buyReturnLabel,
  fetchShippoDefaults,
  fetchShippoSpend,
} from "@/utils/shipping/client-api";

interface RateOption {
  id: string;
  shipmentId: string;
  carrier: string;
  service: string;
  rate: number;
  currency: string;
  deliveryDays?: number | null;
}

interface PurchasedLabel {
  shipmentId: string;
  trackingCode: string;
  trackingUrl?: string | null;
  labelUrl: string;
  labelFormat: string;
  rate: number;
  currency: string;
  carrier: string;
  service: string;
}

type ShipAddress = {
  name?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

export interface BuyShippingLabelModalProps {
  isOpen: boolean;
  onClose: () => void;
  fromZip: string;
  fromCountry?: string;
  toAddress: ShipAddress;
  parcel: {
    weightOz: number;
    lengthIn?: number;
    widthIn?: number;
    heightIn?: number;
  };
  orderId?: string;
  // "outbound" = ship to buyer (default). "return" = generate a return label
  // FROM the buyer's address TO the seller's ship-from defaults.
  mode?: "outbound" | "return";
  onPurchased?: (label: PurchasedLabel) => void;
}

export default function BuyShippingLabelModal({
  isOpen,
  onClose,
  fromZip,
  fromCountry,
  toAddress,
  parcel,
  orderId,
  mode = "outbound",
  onPurchased,
}: BuyShippingLabelModalProps) {
  const { signer, pubkey } = useContext(SignerContext);
  const [loadingRates, setLoadingRates] = useState(false);
  const [rates, setRates] = useState<RateOption[]>([]);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [purchased, setPurchased] = useState<PurchasedLabel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<ShippoDefaults | null>(null);
  const [spend, setSpend] = useState<ShippoSpend | null>(null);
  // Carriers the user has toggled on for this purchase (defaults from settings)
  const [carriers, setCarriers] = useState<string[]>(["USPS"]);

  const isReturn = mode === "return";

  // For return labels, the original "to" (buyer) becomes the new "from"
  // and the seller's saved defaults become the new "to".
  const sellerHasReturnAddress = useMemo(() => {
    if (!isReturn || !defaults) return false;
    return !!(
      defaults.fromStreet1 &&
      defaults.fromCity &&
      defaults.fromState &&
      defaults.fromZip
    );
  }, [isReturn, defaults]);

  useEffect(() => {
    if (!isOpen) {
      setRates([]);
      setSelectedRateId(null);
      setPurchased(null);
      setError(null);
      return;
    }
    if (!signer?.sign || !pubkey) {
      setError(
        "Sign in with your Nostr key to buy shipping labels (needed to authorize the purchase)."
      );
      setRates([]);
      return;
    }

    let cancelled = false;
    const run = async () => {
      // Always load defaults + spend on open (cheap, gives the carriers picker
      // its initial state and shows the daily-cap indicator).
      try {
        const [d, s] = await Promise.all([
          fetchShippoDefaults(signer, pubkey).catch(() => null),
          fetchShippoSpend(signer, pubkey).catch(() => null),
        ]);
        if (cancelled) return;
        setDefaults(d);
        setSpend(s);
        if (d?.preferredCarriers?.length) setCarriers(d.preferredCarriers);
      } catch {
        // non-fatal
      }

      // Return label flow doesn't pre-quote rates — the seller picks the
      // carrier and we buy the cheapest rate from that carrier in one shot.
      if (isReturn) return;

      setLoadingRates(true);
      setError(null);
      try {
        const ownershipProof = buildShippingBuyLabelProof({
          pubkey,
          shipmentId: "pending",
          rateId: "pending",
        });
        const ownershipTemplate = buildMcpRequestProofTemplate(ownershipProof);
        const ownershipSigned = await signer.sign(ownershipTemplate);
        const ownershipHeader = JSON.stringify(ownershipSigned);
        const res = await fetch("/api/shipping/rates", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [MCP_SIGNED_EVENT_HEADER]: ownershipHeader,
          },
          body: JSON.stringify({
            from: {
              street1: "Unknown",
              city: "Unknown",
              state: "",
              zip: fromZip,
              country: fromCountry || "US",
            },
            to: toAddress,
            parcel,
            carriers,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data?.success) {
          setError(data?.error || "No rates available");
          setRates([]);
          return;
        }
        const list = (data.rates || []) as RateOption[];
        list.sort((a, b) => a.rate - b.rate);
        setRates(list);
        if (list[0]) setSelectedRateId(list[0].id);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load rates");
      } finally {
        if (!cancelled) setLoadingRates(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    fromZip,
    fromCountry,
    JSON.stringify(toAddress),
    JSON.stringify(parcel),
    carriers.join(","),
    signer,
    pubkey,
    isReturn,
  ]);

  const toggleCarrier = (id: string) => {
    setCarriers((prev) => {
      const set = new Set(prev);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const next = Array.from(set);
      return next.length > 0 ? next : prev;
    });
  };

  const handleBuy = async () => {
    if (!signer?.sign || !pubkey) {
      setError("Sign in with your Nostr key to buy a label.");
      return;
    }
    setBuying(true);
    setError(null);
    try {
      if (isReturn) {
        if (!defaults || !sellerHasReturnAddress) {
          setError(
            "Set a default ship-from address in Settings → Shipping before issuing return labels."
          );
          return;
        }
        const data = await buyReturnLabel(signer, pubkey, {
          // Reverse: buyer → seller
          from: {
            name: toAddress.name,
            street1: toAddress.street1,
            street2: toAddress.street2,
            city: toAddress.city,
            state: toAddress.state,
            zip: toAddress.zip,
            country: toAddress.country || "US",
          },
          to: {
            name: defaults.fromName || undefined,
            street1: defaults.fromStreet1 as string,
            street2: defaults.fromStreet2 || undefined,
            city: defaults.fromCity as string,
            state: defaults.fromState as string,
            zip: defaults.fromZip as string,
            country: defaults.fromCountry || "US",
            phone: defaults.fromPhone || undefined,
            email: defaults.fromEmail || undefined,
          },
          parcel,
          carriers,
          orderId,
        });
        const label: PurchasedLabel = {
          shipmentId: data.shipmentId,
          trackingCode: data.trackingCode || "",
          trackingUrl: data.trackingUrl,
          labelUrl: data.labelUrl,
          labelFormat: data.labelFormat || "PDF",
          rate: data.rateUsd,
          currency: data.currency,
          carrier: data.carrier || "",
          service: data.service || "",
        };
        setPurchased(label);
        setSpend(data.spend);
        onPurchased?.(label);
        return;
      }

      if (!selectedRateId) return;
      const rate = rates.find((r) => r.id === selectedRateId);
      if (!rate) return;

      const proof = buildShippingBuyLabelProof({
        pubkey,
        shipmentId: rate.shipmentId,
        rateId: rate.id,
      });
      const template = buildMcpRequestProofTemplate(proof);
      const signedEvent = await signer.sign(template);
      const signedHeader = JSON.stringify(signedEvent);

      const fromSummary = `ZIP ${fromZip}`;
      const toSummary = `${toAddress.street1}, ${toAddress.city}, ${toAddress.state} ${toAddress.zip}`;
      const parcelSummary = `${parcel.weightOz} oz${
        parcel.lengthIn && parcel.widthIn && parcel.heightIn
          ? ` ${parcel.lengthIn}×${parcel.widthIn}×${parcel.heightIn} in`
          : ""
      }`;

      const res = await fetch("/api/shipping/buy-label", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [MCP_SIGNED_EVENT_HEADER]: signedHeader,
        },
        body: JSON.stringify({
          shipmentId: rate.shipmentId,
          rateId: rate.id,
          orderId,
          fromSummary,
          toSummary,
          parcelSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Label purchase failed");
        return;
      }
      const label: PurchasedLabel = {
        shipmentId: data.shipmentId,
        trackingCode: data.trackingCode,
        trackingUrl: data.trackingUrl,
        labelUrl: data.labelUrl,
        labelFormat: data.labelFormat,
        rate: data.rate,
        currency: data.currency,
        carrier: data.carrier,
        service: data.service,
      };
      setPurchased(label);
      if (data.spend) setSpend(data.spend);
      onPurchased?.(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Label purchase failed");
    } finally {
      setBuying(false);
    }
  };

  const spendPct =
    spend && spend.capUsd > 0
      ? Math.min(100, Math.round((spend.spentUsd / spend.capUsd) * 100))
      : 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" backdrop="blur">
      <ModalContent className="border-2 border-black bg-white text-black">
        <ModalHeader className="flex flex-col gap-1">
          {isReturn ? "Buy Return Label" : "Buy Shipping Label"}
        </ModalHeader>
        <ModalBody>
          {spend && (
            <div className="mb-2">
              <div className="flex items-baseline justify-between text-xs text-gray-700">
                <span>
                  Daily spend: ${spend.spentUsd.toFixed(2)} / $
                  {spend.capUsd.toFixed(2)}
                </span>
                <span>${spend.remainingUsd.toFixed(2)} remaining</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded border border-black bg-white">
                <div
                  className={`h-full ${
                    spendPct >= 90
                      ? "bg-red-500"
                      : spendPct >= 70
                        ? "bg-yellow-400"
                        : "bg-green-500"
                  }`}
                  style={{ width: `${spendPct}%` }}
                />
              </div>
            </div>
          )}

          {purchased ? (
            <div className="space-y-3">
              <p className="font-semibold text-green-700">
                Label purchased successfully
              </p>
              <p className="text-sm">
                {purchased.carrier} {purchased.service} — $
                {purchased.rate.toFixed(2)} {purchased.currency}
              </p>
              {purchased.trackingCode && (
                <p className="text-sm">
                  Tracking:{" "}
                  {purchased.trackingUrl ? (
                    <a
                      href={purchased.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-700 underline"
                    >
                      {purchased.trackingCode}
                    </a>
                  ) : (
                    purchased.trackingCode
                  )}
                </p>
              )}
              <a
                href={purchased.labelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-primary-yellow inline-block rounded-md border-2 border-black px-4 py-2 font-semibold hover:bg-yellow-300"
              >
                Download label ({purchased.labelFormat})
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-gray-700">
                {isReturn ? (
                  <>
                    <div>
                      <strong>Return from:</strong> {toAddress.street1},{" "}
                      {toAddress.city}, {toAddress.state} {toAddress.zip}
                    </div>
                    <div>
                      <strong>Return to:</strong>{" "}
                      {sellerHasReturnAddress
                        ? `${defaults?.fromStreet1}, ${defaults?.fromCity}, ${defaults?.fromState} ${defaults?.fromZip}`
                        : "Set a default ship-from address in Settings → Shipping"}
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <strong>From ZIP:</strong> {fromZip}
                    </div>
                    <div>
                      <strong>To:</strong> {toAddress.street1},{" "}
                      {toAddress.street2 ? toAddress.street2 + ", " : ""}
                      {toAddress.city}, {toAddress.state} {toAddress.zip}
                    </div>
                  </>
                )}
                <div>
                  <strong>Weight:</strong> {parcel.weightOz} oz
                  {parcel.lengthIn && parcel.widthIn && parcel.heightIn
                    ? ` • ${parcel.lengthIn}×${parcel.widthIn}×${parcel.heightIn} in`
                    : ""}
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-semibold text-black">
                  Carriers
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUPPORTED_CARRIERS.map((c) => {
                    const active = carriers.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCarrier(c.id)}
                        className={`rounded-md border-2 border-black px-2.5 py-1 text-xs font-semibold ${
                          active
                            ? "bg-primary-yellow text-black"
                            : "bg-white text-black hover:bg-gray-100"
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {!isReturn && loadingRates && <p>Loading rates…</p>}
              {error && <p className="text-red-700">{error}</p>}

              {!isReturn && !loadingRates && rates.length > 0 && (
                <div className="space-y-2">
                  {rates.map((r) => (
                    <label
                      key={r.id}
                      className={`flex cursor-pointer items-center justify-between rounded-md border-2 p-3 ${
                        selectedRateId === r.id
                          ? "border-black bg-yellow-50"
                          : "border-gray-300 bg-white"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="shipping-rate"
                          checked={selectedRateId === r.id}
                          onChange={() => setSelectedRateId(r.id)}
                        />
                        <span>
                          <strong>
                            {r.carrier} {r.service}
                          </strong>
                          {r.deliveryDays
                            ? ` • ~${r.deliveryDays} day${r.deliveryDays === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      </span>
                      <span className="font-semibold">
                        ${r.rate.toFixed(2)} {r.currency}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {!isReturn && !loadingRates && rates.length === 0 && !error && (
                <p>No rates available for this shipment.</p>
              )}

              {isReturn && (
                <p className="text-xs text-gray-600">
                  We&apos;ll buy the cheapest available rate from the selected
                  carriers and send you a return label PDF.
                </p>
              )}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            {purchased ? "Close" : "Cancel"}
          </Button>
          {!purchased && (
            <Button
              className="bg-primary-yellow font-semibold text-black"
              onPress={handleBuy}
              isDisabled={
                buying ||
                loadingRates ||
                (isReturn ? !sellerHasReturnAddress : !selectedRateId) ||
                (spend ? spend.remainingUsd <= 0 : false)
              }
              isLoading={buying}
            >
              {isReturn ? "Buy Return Label" : "Buy Label"}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
