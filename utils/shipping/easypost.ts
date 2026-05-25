import type {
  ParcelInput,
  PurchasedLabel,
  ShippingAddressInput,
  ShippingRate,
  VerifiedAddress,
} from "@/utils/shipping/types";

const EASYPOST_BASE = "https://api.easypost.com/v2";

function getAuthHeader(): string {
  const key = process.env.EASYPOST_API_KEY;
  if (!key) {
    throw new Error("EASYPOST_API_KEY is not configured");
  }
  const token = Buffer.from(`${key}:`).toString("base64");
  return `Basic ${token}`;
}

export function isEasyPostConfigured(): boolean {
  return !!process.env.EASYPOST_API_KEY;
}

export function isEasyPostTestMode(): boolean {
  const key = process.env.EASYPOST_API_KEY || "";
  // EZTK = Test, EZAK = Production. Default to "live" for unknown prefixes.
  return key.startsWith("EZTK");
}

interface EasyPostError {
  error?: { code?: string; message?: string; errors?: unknown };
}

async function epFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${EASYPOST_BASE}${path}`, {
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
    const errData = data as EasyPostError | null;
    const message =
      errData?.error?.message ||
      (typeof data === "string" ? (data as string) : "") ||
      text ||
      `EasyPost request failed (${res.status})`;
    const err = new Error(message) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = errData?.error?.code;
    throw err;
  }

  return data as T;
}

interface EpAddress {
  id: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  verifications?: {
    delivery?: {
      success?: boolean;
      errors?: Array<{ code?: string; message?: string }>;
      details?: unknown;
    };
    zip4?: { success?: boolean };
  };
}

export async function verifyAddress(
  input: ShippingAddressInput
): Promise<VerifiedAddress> {
  const body = {
    address: {
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
      verify: ["delivery"],
    },
  };

  const addr = await epFetch<EpAddress>("/addresses", {
    method: "POST",
    body,
  });

  const deliveryOk = !!addr.verifications?.delivery?.success;
  const errors = addr.verifications?.delivery?.errors || [];

  return {
    valid: deliveryOk,
    street1: addr.street1 || input.street1,
    street2: addr.street2 || input.street2 || "",
    city: addr.city || input.city,
    state: addr.state || input.state,
    zip: addr.zip || input.zip,
    country: addr.country || input.country,
    messages: errors.map((e) => ({
      source: "delivery",
      type: e.code,
      text: e.message || e.code || "Address validation issue",
    })),
  };
}

interface EpRate {
  id: string;
  service: string;
  carrier: string;
  rate: string;
  currency: string;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  delivery_date?: string | null;
}

interface EpShipment {
  id: string;
  rates: EpRate[];
  messages?: Array<{ carrier?: string; type?: string; message?: string }>;
}

function mapRates(shipmentId: string, rates: EpRate[]): ShippingRate[] {
  return rates.map((r) => ({
    id: r.id,
    shipmentId,
    carrier: r.carrier,
    service: r.service,
    rate: Number(r.rate),
    currency: r.currency,
    deliveryDays: r.delivery_days ?? r.est_delivery_days ?? null,
    estDeliveryDate: r.delivery_date ?? null,
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
    shipment: {
      to_address: addressToEp(args.to),
      from_address: addressToEp(args.from),
      parcel: parcelToEp(args.parcel),
    },
  };

  const shipment = await epFetch<EpShipment>("/shipments", {
    method: "POST",
    body,
  });

  const allRates = mapRates(shipment.id, shipment.rates || []);
  const filtered = allRates.filter((r) =>
    wantedCarriers.includes(r.carrier.toUpperCase())
  );
  const pool = filtered.length > 0 ? filtered : allRates;
  const cheapest = pool.reduce<ShippingRate | null>((acc, r) => {
    if (!acc) return r;
    return r.rate < acc.rate ? r : acc;
  }, null);

  return {
    shipmentId: shipment.id,
    rates: pool,
    cheapest,
  };
}

function addressToEp(a: ShippingAddressInput) {
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

function parcelToEp(p: ParcelInput) {
  // EasyPost expects ounces for weight and inches for dimensions.
  return {
    weight: p.weightOz,
    length: p.lengthIn,
    width: p.widthIn,
    height: p.heightIn,
  };
}

export interface BuyLabelArgs {
  shipmentId: string;
  rateId: string;
  insuranceAmount?: number;
}

interface EpBoughtShipment {
  id: string;
  tracking_code?: string;
  tracker?: { public_url?: string };
  postage_label?: {
    label_url?: string;
    label_file_type?: string;
  };
  selected_rate?: EpRate;
}

export async function buyLabel(args: BuyLabelArgs): Promise<PurchasedLabel> {
  const body: Record<string, unknown> = { rate: { id: args.rateId } };
  if (typeof args.insuranceAmount === "number" && args.insuranceAmount > 0) {
    body.insurance = String(args.insuranceAmount);
  }

  const shipment = await epFetch<EpBoughtShipment>(
    `/shipments/${encodeURIComponent(args.shipmentId)}/buy`,
    { method: "POST", body }
  );

  const rate = shipment.selected_rate;
  const label = shipment.postage_label;
  if (!label?.label_url || !rate) {
    throw new Error("EasyPost did not return a label URL");
  }

  return {
    shipmentId: shipment.id,
    trackingCode: shipment.tracking_code || "",
    trackingUrl: shipment.tracker?.public_url || null,
    labelUrl: label.label_url,
    labelFormat: label.label_file_type || "PDF",
    rate: Number(rate.rate),
    currency: rate.currency,
    carrier: rate.carrier,
    service: rate.service,
  };
}
