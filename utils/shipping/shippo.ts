import type {
  ParcelInput,
  PurchasedLabel,
  ShippingAddressInput,
  ShippingRate,
  VerifiedAddress,
} from "@/utils/shipping/types";

const SHIPPO_BASE = "https://api.goshippo.com";

function getAuthHeader(): string {
  const key = process.env.SHIPPO_API_KEY;
  if (!key) {
    throw new Error("SHIPPO_API_KEY is not configured");
  }
  return `ShippoToken ${key}`;
}

export function isShippoConfigured(): boolean {
  return !!process.env.SHIPPO_API_KEY;
}

export function isShippoTestMode(): boolean {
  const key = process.env.SHIPPO_API_KEY || "";
  // shippo_test_ = Test, shippo_live_ = Production. Default to "live" for unknown prefixes.
  return key.startsWith("shippo_test_");
}

interface ShippoError {
  detail?: string;
  message?: string;
  [key: string]: unknown;
}

async function shippoFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not json; keep null and surface raw text in error
  }

  if (!res.ok) {
    const errData = data as ShippoError | null;
    const message =
      errData?.detail ||
      errData?.message ||
      (typeof data === "string" ? (data as string) : "") ||
      text ||
      `Shippo request failed (${res.status})`;
    const err = new Error(message) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }

  return data as T;
}

interface ShippoAddress {
  object_id: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  validation_results?: {
    is_valid?: boolean;
    messages?: Array<{
      code?: string;
      source?: string;
      type?: string;
      text?: string;
    }>;
  };
}

export async function verifyAddress(
  input: ShippingAddressInput
): Promise<VerifiedAddress> {
  const body = {
    name: input.name,
    company: input.company,
    street1: input.street1,
    street2: input.street2,
    city: input.city,
    state: input.state,
    zip: input.zip,
    country: input.country,
    phone: input.phone,
    email: input.email,
    validate: true,
  };

  const addr = await shippoFetch<ShippoAddress>("/addresses/", {
    method: "POST",
    body,
  });

  const isValid = !!addr.validation_results?.is_valid;
  const messages = addr.validation_results?.messages || [];

  return {
    valid: isValid,
    street1: addr.street1 || input.street1,
    street2: addr.street2 || input.street2 || "",
    city: addr.city || input.city,
    state: addr.state || input.state,
    zip: addr.zip || input.zip,
    country: addr.country || input.country,
    messages: messages.map((m) => ({
      source: m.source || "delivery",
      type: m.code || m.type,
      text: m.text || m.code || "Address validation issue",
    })),
  };
}

interface ShippoRate {
  object_id: string;
  servicelevel?: { name?: string; token?: string };
  provider: string;
  amount: string;
  currency: string;
  estimated_days?: number | null;
  duration_terms?: string | null;
}

interface ShippoShipment {
  object_id: string;
  rates: ShippoRate[];
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

function mapRates(shipmentId: string, rates: ShippoRate[]): ShippingRate[] {
  return rates.map((r) => ({
    id: r.object_id,
    shipmentId,
    carrier: r.provider,
    service: r.servicelevel?.name || r.servicelevel?.token || "",
    rate: Number(r.amount),
    currency: r.currency,
    deliveryDays: r.estimated_days ?? null,
    estDeliveryDate: null,
  }));
}

export interface GetRatesArgs {
  from: ShippingAddressInput;
  to: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[]; // default ["USPS"]
}

export interface GetRatesResult {
  shipmentId: string;
  rates: ShippingRate[];
  cheapest: ShippingRate | null;
}

export async function getRates(args: GetRatesArgs): Promise<GetRatesResult> {
  const wantedCarriers = (args.carriers || ["USPS"]).map((c) =>
    c.toUpperCase()
  );

  const body = {
    address_from: addressToShippo(args.from),
    address_to: addressToShippo(args.to),
    parcels: [parcelToShippo(args.parcel)],
    async: false,
  };

  const shipment = await shippoFetch<ShippoShipment>("/shipments/", {
    method: "POST",
    body,
  });

  const allRates = mapRates(shipment.object_id, shipment.rates || []);
  const filtered = allRates.filter((r) =>
    wantedCarriers.includes(r.carrier.toUpperCase())
  );
  const pool = filtered.length > 0 ? filtered : allRates;
  const cheapest = pool.reduce<ShippingRate | null>((acc, r) => {
    if (!acc) return r;
    return r.rate < acc.rate ? r : acc;
  }, null);

  return {
    shipmentId: shipment.object_id,
    rates: pool,
    cheapest,
  };
}

function addressToShippo(a: ShippingAddressInput) {
  return {
    name: a.name,
    company: a.company,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country,
    phone: a.phone,
    email: a.email,
  };
}

function parcelToShippo(p: ParcelInput) {
  // Shippo accepts mixed units per field via mass_unit/distance_unit.
  return {
    length: String(p.lengthIn ?? 0),
    width: String(p.widthIn ?? 0),
    height: String(p.heightIn ?? 0),
    distance_unit: "in",
    weight: String(p.weightOz),
    mass_unit: "oz",
  };
}

export interface BuyLabelArgs {
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
}

interface ShippoTransaction {
  object_id: string;
  status: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  label_url?: string;
  label_file_type?: string;
  rate?: string | ShippoRate;
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

export async function buyLabel(args: BuyLabelArgs): Promise<PurchasedLabel> {
  const body: Record<string, unknown> = {
    rate: args.rateId,
    label_file_type: "PDF",
    async: false,
  };
  if (typeof args.insuranceAmount === "number" && args.insuranceAmount > 0) {
    body.insurance_amount = String(args.insuranceAmount);
  }
  return buildTransaction(args.shipmentId, body);
}

export interface BuyReturnLabelArgs {
  // Original outbound shipment to reverse (from/to swapped).
  from: ShippingAddressInput;
  to: ShippingAddressInput;
  parcel: ParcelInput;
  carriers?: string[];
  // Service token (e.g., "usps_priority") to match the outbound service when
  // possible. If omitted, the cheapest matching carrier rate is used.
  serviceToken?: string;
  insuranceAmount?: number;
}

export async function buyReturnLabel(
  args: BuyReturnLabelArgs
): Promise<PurchasedLabel> {
  // Shippo supports return shipments by setting `return: true` on the
  // shipment. The label is generated against the swapped from/to.
  const wantedCarriers = (args.carriers || ["USPS"]).map((c) =>
    c.toUpperCase()
  );

  const shipmentBody = {
    address_from: addressToShippo(args.to),
    address_to: addressToShippo(args.from),
    parcels: [parcelToShippo(args.parcel)],
    return: true,
    async: false,
  };

  const shipment = await shippoFetch<ShippoShipment>("/shipments/", {
    method: "POST",
    body: shipmentBody,
  });

  const allRates = shipment.rates || [];
  const matchingCarrier = allRates.filter((r) =>
    wantedCarriers.includes(r.provider.toUpperCase())
  );
  const pool = matchingCarrier.length > 0 ? matchingCarrier : allRates;

  let selected: ShippoRate | null = null;
  if (args.serviceToken) {
    selected =
      pool.find(
        (r) =>
          r.servicelevel?.token?.toLowerCase() ===
          args.serviceToken?.toLowerCase()
      ) || null;
  }
  if (!selected) {
    selected = pool.reduce<ShippoRate | null>((acc, r) => {
      if (!acc) return r;
      return Number(r.amount) < Number(acc.amount) ? r : acc;
    }, null);
  }
  if (!selected) {
    throw new Error("No return label rate available from any carrier");
  }

  const body: Record<string, unknown> = {
    rate: selected.object_id,
    label_file_type: "PDF",
    async: false,
  };
  if (typeof args.insuranceAmount === "number" && args.insuranceAmount > 0) {
    body.insurance_amount = String(args.insuranceAmount);
  }
  return buildTransaction(shipment.object_id, body);
}

async function buildTransaction(
  shipmentId: string,
  body: Record<string, unknown>
): Promise<PurchasedLabel> {
  const tx = await shippoFetch<ShippoTransaction>("/transactions/", {
    method: "POST",
    body,
  });

  if (tx.status !== "SUCCESS") {
    const msg =
      tx.messages
        ?.map((m) => m.text)
        .filter(Boolean)
        .join("; ") || `Label purchase failed with status ${tx.status}`;
    throw new Error(msg);
  }

  if (!tx.label_url) {
    throw new Error("Shippo did not return a label URL");
  }

  // The rate field on a successful transaction is an object_id string; we need
  // to fetch the full rate to get amount/currency/provider/service.
  let rateDetails: ShippoRate | null = null;
  if (typeof tx.rate === "string") {
    try {
      rateDetails = await shippoFetch<ShippoRate>(`/rates/${tx.rate}/`);
    } catch {
      rateDetails = null;
    }
  } else if (tx.rate && typeof tx.rate === "object") {
    rateDetails = tx.rate;
  }

  return {
    shipmentId,
    trackingCode: tx.tracking_number || "",
    trackingUrl: tx.tracking_url_provider || null,
    labelUrl: tx.label_url,
    labelFormat: tx.label_file_type || "PDF",
    rate: rateDetails ? Number(rateDetails.amount) : 0,
    currency: rateDetails?.currency || "USD",
    carrier: rateDetails?.provider || "",
    service:
      rateDetails?.servicelevel?.name || rateDetails?.servicelevel?.token || "",
  };
}
