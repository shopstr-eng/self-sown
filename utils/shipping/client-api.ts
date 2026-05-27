// Browser-side helpers for signing and calling the /api/shipping/* endpoints.
// All write/read endpoints below require a NIP-98–style signed kind-27235
// proof event in the x-mcp-signed-event header (see utils/mcp/request-proof).

import {
  MCP_SIGNED_EVENT_HEADER,
  buildMcpRequestProofTemplate,
  buildShippingDefaultsProof,
  buildShippingListLabelsProof,
  buildShippingParcelTemplatesProof,
  buildShippingReturnLabelProof,
  buildShippingSpendProof,
  type McpRequestProof,
} from "@/utils/mcp/request-proof";
import { NostrEventTemplate } from "@/utils/nostr/nostr-manager";

export interface ShippoSpend {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  windowStart: string;
  windowEnd: string;
}

export interface ShippoLabel {
  id: number;
  shipmentId: string;
  orderId: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  labelUrl: string;
  labelFormat: string | null;
  rateUsd: number;
  currency: string;
  carrier: string | null;
  service: string | null;
  isReturn: boolean;
  fromSummary: string | null;
  toSummary: string | null;
  parcelSummary: string | null;
  purchasedAt: string;
}

export interface ShippoParcelTemplate {
  id: number;
  name: string;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
}

export interface ShippoDefaults {
  fromName: string | null;
  fromCompany: string | null;
  fromStreet1: string | null;
  fromStreet2: string | null;
  fromCity: string | null;
  fromState: string | null;
  fromZip: string | null;
  fromCountry: string;
  fromPhone: string | null;
  fromEmail: string | null;
  preferredCarriers: string[];
}

type Signer = { sign: (t: NostrEventTemplate) => Promise<{ kind: number }> };

async function signedHeader(
  signer: Signer,
  proof: McpRequestProof
): Promise<string> {
  const template = buildMcpRequestProofTemplate(proof);
  const signed = await signer.sign(template);
  return JSON.stringify(signed);
}

export async function fetchShippoSpend(
  signer: Signer,
  pubkey: string
): Promise<ShippoSpend> {
  const header = await signedHeader(signer, buildShippingSpendProof(pubkey));
  const res = await fetch("/api/shipping/spend", {
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return data.spend as ShippoSpend;
}

export async function fetchShippoLabels(
  signer: Signer,
  pubkey: string
): Promise<ShippoLabel[]> {
  const header = await signedHeader(
    signer,
    buildShippingListLabelsProof(pubkey)
  );
  const res = await fetch("/api/shipping/labels", {
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return (data.labels || []) as ShippoLabel[];
}

export async function fetchShippoDefaults(
  signer: Signer,
  pubkey: string
): Promise<ShippoDefaults | null> {
  const header = await signedHeader(
    signer,
    buildShippingDefaultsProof({ pubkey, method: "GET" })
  );
  const res = await fetch("/api/shipping/defaults", {
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return (data.defaults as ShippoDefaults | null) || null;
}

export async function saveShippoDefaults(
  signer: Signer,
  pubkey: string,
  defaults: Partial<ShippoDefaults>
): Promise<ShippoDefaults> {
  const header = await signedHeader(
    signer,
    buildShippingDefaultsProof({ pubkey, method: "POST" })
  );
  const res = await fetch("/api/shipping/defaults", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [MCP_SIGNED_EVENT_HEADER]: header,
    },
    body: JSON.stringify(defaults),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return data.defaults as ShippoDefaults;
}

export async function listShippoParcelTemplates(
  signer: Signer,
  pubkey: string
): Promise<ShippoParcelTemplate[]> {
  const header = await signedHeader(
    signer,
    buildShippingParcelTemplatesProof({ pubkey, method: "GET" })
  );
  const res = await fetch("/api/shipping/parcel-templates", {
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return (data.templates || []) as ShippoParcelTemplate[];
}

export async function upsertShippoParcelTemplate(
  signer: Signer,
  pubkey: string,
  template: {
    name: string;
    weightOz: number;
    lengthIn?: number | null;
    widthIn?: number | null;
    heightIn?: number | null;
  }
): Promise<ShippoParcelTemplate> {
  const header = await signedHeader(
    signer,
    buildShippingParcelTemplatesProof({ pubkey, method: "POST" })
  );
  const res = await fetch("/api/shipping/parcel-templates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [MCP_SIGNED_EVENT_HEADER]: header,
    },
    body: JSON.stringify(template),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return data.template as ShippoParcelTemplate;
}

export async function deleteShippoParcelTemplate(
  signer: Signer,
  pubkey: string,
  id: number
): Promise<void> {
  const header = await signedHeader(
    signer,
    buildShippingParcelTemplatesProof({ pubkey, method: "DELETE" })
  );
  const res = await fetch(`/api/shipping/parcel-templates?id=${id}`, {
    method: "DELETE",
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
}

export interface BuyReturnLabelInput {
  from: {
    name?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
    email?: string;
  };
  to: BuyReturnLabelInput["from"];
  parcel: {
    weightOz: number;
    lengthIn?: number;
    widthIn?: number;
    heightIn?: number;
  };
  carriers?: string[];
  serviceToken?: string;
  orderId?: string;
}

export async function buyReturnLabel(
  signer: Signer,
  pubkey: string,
  input: BuyReturnLabelInput
): Promise<ShippoLabel & { spend: ShippoSpend }> {
  const header = await signedHeader(
    signer,
    buildShippingReturnLabelProof(pubkey)
  );
  const res = await fetch("/api/shipping/return-label", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [MCP_SIGNED_EVENT_HEADER]: header,
    },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return data as ShippoLabel & { spend: ShippoSpend };
}

export const SUPPORTED_CARRIERS = [
  { id: "USPS", label: "USPS" },
  { id: "UPS", label: "UPS" },
  { id: "FEDEX", label: "FedEx" },
  { id: "DHL_EXPRESS", label: "DHL Express" },
  { id: "CANADA_POST", label: "Canada Post" },
] as const;
