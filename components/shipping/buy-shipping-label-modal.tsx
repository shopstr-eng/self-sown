import { useEffect, useState } from "react";
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
import { useContext } from "react";

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

export interface BuyShippingLabelModalProps {
  isOpen: boolean;
  onClose: () => void;
  fromZip: string;
  fromCountry?: string;
  toAddress: {
    name?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  parcel: {
    weightOz: number;
    lengthIn?: number;
    widthIn?: number;
    heightIn?: number;
  };
  onPurchased?: (label: PurchasedLabel) => void;
}

export default function BuyShippingLabelModal({
  isOpen,
  onClose,
  fromZip,
  fromCountry,
  toAddress,
  parcel,
  onPurchased,
}: BuyShippingLabelModalProps) {
  const { signer, pubkey } = useContext(SignerContext);
  const [loadingRates, setLoadingRates] = useState(false);
  const [rates, setRates] = useState<RateOption[]>([]);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [purchased, setPurchased] = useState<PurchasedLabel | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setLoadingRates(true);
      setError(null);
      try {
        // Sign an ownership-registration proof: we reuse the buy-label proof
        // structure but with a placeholder rateId — the server only uses this
        // header to record `shipmentId → pubkey`, and re-validates the real
        // proof at purchase time with the actual rateId.
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
            carriers: ["USPS"],
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
  }, [isOpen, fromZip, fromCountry, toAddress, parcel, signer, pubkey]);

  const handleBuy = async () => {
    if (!selectedRateId) return;
    const rate = rates.find((r) => r.id === selectedRateId);
    if (!rate) return;

    setBuying(true);
    setError(null);
    try {
      if (!signer?.sign || !pubkey) {
        setError("Sign in with your Nostr key to buy a label.");
        return;
      }
      const proof = buildShippingBuyLabelProof({
        pubkey,
        shipmentId: rate.shipmentId,
        rateId: rate.id,
      });
      const template = buildMcpRequestProofTemplate(proof);
      const signedEvent = await signer.sign(template);
      const signedHeader = JSON.stringify(signedEvent);

      const res = await fetch("/api/shipping/buy-label", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [MCP_SIGNED_EVENT_HEADER]: signedHeader,
        },
        body: JSON.stringify({
          shipmentId: rate.shipmentId,
          rateId: rate.id,
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
      onPurchased?.(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Label purchase failed");
    } finally {
      setBuying(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" backdrop="blur">
      <ModalContent className="border-2 border-black bg-white text-black">
        <ModalHeader className="flex flex-col gap-1">
          Buy USPS Shipping Label
        </ModalHeader>
        <ModalBody>
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
                <div>
                  <strong>From ZIP:</strong> {fromZip}
                </div>
                <div>
                  <strong>To:</strong> {toAddress.street1},{" "}
                  {toAddress.street2 ? toAddress.street2 + ", " : ""}
                  {toAddress.city}, {toAddress.state} {toAddress.zip}
                </div>
                <div>
                  <strong>Weight:</strong> {parcel.weightOz} oz
                  {parcel.lengthIn && parcel.widthIn && parcel.heightIn
                    ? ` • ${parcel.lengthIn}×${parcel.widthIn}×${parcel.heightIn} in`
                    : ""}
                </div>
              </div>

              {loadingRates && <p>Loading USPS rates…</p>}
              {error && <p className="text-red-700">{error}</p>}

              {!loadingRates && rates.length > 0 && (
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

              {!loadingRates && rates.length === 0 && !error && (
                <p>No USPS rates available for this shipment.</p>
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
              isDisabled={!selectedRateId || buying || loadingRates}
              isLoading={buying}
            >
              Buy Label
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
