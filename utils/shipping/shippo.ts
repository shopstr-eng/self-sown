import type {
  ParcelInput,
  PurchasedLabel,
  ShippingAddressInput,
  ShippingRate,
  VerifiedAddress,
} from "@/utils/shipping/types";

const SHIPPO_BASE = "https://api.goshippo.com";

// Per-seller OAuth access token (prefix `oauth.`). In the gray-label model the
// platform never holds a Shippo key; every Shippo call is authenticated with
// the connected seller's own bearer token.
function getAuthHeader(accessToken: string): string {
  if (!accessToken) {
    throw new Error("Shippo account is not connected");
  }
  return `Bearer ${accessToken}`;
}

interface ShippoError {
  detail?: string;
  message?: string;
  [key: string]: unknown;
}

async function shippoFetch<T>(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  // Cap every Shippo call so a hung upstream can't tie up a request handler —
  // these run on the buyer checkout hot path (rates / address verification).
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: getAuthHeader(accessToken),
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
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
  accessToken: string,
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

  const addr = await shippoFetch<ShippoAddress>(accessToken, "/addresses/", {
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

export async function getRates(
  accessToken: string,
  args: GetRatesArgs
): Promise<GetRatesResult> {
  const wantedCarriers = (args.carriers || ["USPS"]).map((c) =>
    c.toUpperCase()
  );

  const body = {
    address_from: addressToShippo(args.from),
    address_to: addressToShippo(args.to),
    parcels: [parcelToShippo(args.parcel)],
    async: false,
  };

  const shipment = await shippoFetch<ShippoShipment>(
    accessToken,
    "/shipments/",
    {
      method: "POST",
      body,
    }
  );

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
  /**
   * Caller-controlled string stamped onto the Shippo transaction. Purchase
   * paths set this to their durable claim key so a lost purchase response can
   * be reconciled against the transaction list (transactions carry no
   * shipment id — this is the only caller-controlled handle).
   */
  metadata?: string;
}

interface ShippoTransaction {
  object_id: string;
  status: string;
  // Shippo transactions carry NO shipment id — reconciliation matches on the
  // claim key stamped into `metadata` at purchase time (see buyLabel).
  metadata?: string;
  object_created?: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  label_url?: string;
  label_file_type?: string;
  rate?: string | ShippoRate;
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

export async function buyLabel(
  accessToken: string,
  args: BuyLabelArgs
): Promise<PurchasedLabel> {
  const body: Record<string, unknown> = {
    rate: args.rateId,
    label_file_type: "PDF",
    async: false,
  };
  if (typeof args.insuranceAmount === "number" && args.insuranceAmount > 0) {
    body.insurance_amount = String(args.insuranceAmount);
  }
  // Stamp the caller's claim key so a lost purchase response can be
  // reconciled against the transaction list (Shippo transactions carry no
  // shipment id — metadata is the only caller-controlled handle).
  if (args.metadata) body.metadata = args.metadata;
  return buildTransaction(accessToken, args.shipmentId, body);
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
  accessToken: string,
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

  const shipment = await shippoFetch<ShippoShipment>(
    accessToken,
    "/shipments/",
    {
      method: "POST",
      body: shipmentBody,
    }
  );

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
  return buildTransaction(accessToken, shipment.object_id, body);
}

async function buildTransaction(
  accessToken: string,
  shipmentId: string,
  body: Record<string, unknown>
): Promise<PurchasedLabel> {
  const tx = await shippoFetch<ShippoTransaction>(
    accessToken,
    "/transactions/",
    {
      method: "POST",
      body,
    }
  );

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

  return transactionToLabel(accessToken, tx, shipmentId);
}

// Map a Shippo transaction to a PurchasedLabel. The rate field on a
// transaction is an object_id string, so a rate detail fetch may be needed
// for amount/currency/provider/service.
async function transactionToLabel(
  accessToken: string,
  tx: ShippoTransaction,
  shipmentId: string
): Promise<PurchasedLabel> {
  let rateDetails: ShippoRate | null = null;
  if (typeof tx.rate === "string") {
    try {
      rateDetails = await shippoFetch<ShippoRate>(
        accessToken,
        `/rates/${tx.rate}/`
      );
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
    labelUrl: tx.label_url || "",
    labelFormat: tx.label_file_type || "PDF",
    rate: rateDetails ? Number(rateDetails.amount) : 0,
    currency: rateDetails?.currency || "USD",
    carrier: rateDetails?.provider || "",
    service:
      rateDetails?.servicelevel?.name || rateDetails?.servicelevel?.token || "",
  };
}

interface ShippoTransactionList {
  results?: ShippoTransaction[];
  next?: string | null;
}

export type ShipmentChargeState = "charged" | "in-flight" | "none";

export interface ShipmentChargeLookup {
  /**
   * The reconstructed label, present only when a charged transaction ALSO
   * carries usable label metadata. A "charged" state with a null label is
   * still a charge — Shippo can report SUCCESS without a label_url (buyLabel
   * itself throws on that response), so the seller was billed even though no
   * label can be reconstructed. Callers must treat it as money spent.
   */
  label: PurchasedLabel | null;
  /**
   * - "charged": a matching transaction reached a money-moving state
   *   (SUCCESS, or a refund-track status — the charge happened even if it was
   *   later refunded). NEVER buy again.
   * - "in-flight": a matching transaction is in a nonterminal state
   *   (WAITING/QUEUED/unknown) and may still succeed — "not found" is not
   *   proof of "no charge". Fail closed.
   * - "none": only terminal failures (ERROR) or no matching transaction at
   *   all — and even then only trustworthy when coveredWindow is true.
   */
  chargeState: ShipmentChargeState;
  /**
   * True only when the scan covered every transaction back through `sinceMs`
   * (or exhausted the account's transaction list). A "none" state is proof of
   * "no charge" ONLY when this is true — a high-volume account can push a
   * transaction past the scanned pages, so an uncovered window must be
   * treated as UNKNOWN, never as "no charge".
   */
  coveredWindow: boolean;
}

// Statuses where Shippo moved (or is reversing) money. REFUND* all imply the
// charge landed first, so they block any rebuy just like SUCCESS.
const CHARGED_TX_STATUSES = new Set(["SUCCESS", "REFUNDED", "REFUNDPENDING"]);
// Terminal statuses where the charge definitively did not happen.
const UNCHARGED_TX_STATUSES = new Set(["ERROR", "REFUNDREJECTED"]);

/**
 * Reconciliation for the non-idempotent purchase POST: when a buyLabel call's
 * outcome was lost (timeout/network failure after Shippo may have accepted
 * the charge), find the transaction stamped with this claim's reconcile token
 * and determine what Shippo actually recorded. Pages the newest-first
 * transaction list until it reaches transactions older than `sinceMs` (the
 * claim's charge window) or the list ends; a page-cap exit reports
 * coveredWindow=false. One attempt can produce several transactions (Shippo
 * retries), so the scan only stops early on a CHARGED match — an in-flight
 * or failed transaction on a newer page never hides a charge on an older one.
 */
export async function lookupShipmentCharge(args: {
  accessToken: string;
  shipmentId: string;
  reconcileToken: string;
  sinceMs: number;
}): Promise<ShipmentChargeLookup> {
  let path: string | null = "/transactions/?results=25";
  let sawInFlight = false;
  for (let page = 0; page < 8 && path; page++) {
    const list: ShippoTransactionList =
      await shippoFetch<ShippoTransactionList>(args.accessToken, path, {
        method: "GET",
      });
    const txs: ShippoTransaction[] = list.results || [];
    const matches = txs.filter(
      (tx: ShippoTransaction) => tx.metadata === args.reconcileToken
    );
    const charged = matches.find((tx: ShippoTransaction) =>
      CHARGED_TX_STATUSES.has(tx.status)
    );
    if (charged) {
      return {
        // No label_url: the charge happened but the label metadata is
        // unusable — report the charge with a null label rather than
        // pretending nothing was billed.
        label: charged.label_url
          ? await transactionToLabel(args.accessToken, charged, args.shipmentId)
          : null,
        chargeState: "charged",
        coveredWindow: true,
      };
    }
    if (
      matches.some(
        (tx: ShippoTransaction) => !UNCHARGED_TX_STATUSES.has(tx.status)
      )
    ) {
      sawInFlight = true;
    }
    const oldestMs = txs.reduce((min, tx) => {
      const t = Date.parse(tx.object_created || "");
      return Number.isFinite(t) && t < min ? t : min;
    }, Infinity);
    if (oldestMs <= args.sinceMs) {
      return {
        label: null,
        chargeState: sawInFlight ? "in-flight" : "none",
        coveredWindow: true,
      };
    }
    const nextUrl: string | null | undefined = list.next;
    // The list is exhausted — every transaction was scanned, so the window
    // is covered by definition.
    if (!nextUrl) {
      return {
        label: null,
        chargeState: sawInFlight ? "in-flight" : "none",
        coveredWindow: true,
      };
    }
    path = nextUrl.replace(/^https?:\/\/[^/]+/, "");
  }
  // Page cap hit before reaching the claim's window: prove nothing — but an
  // in-flight sighting still fails closed.
  return {
    label: null,
    chargeState: sawInFlight ? "in-flight" : "none",
    coveredWindow: false,
  };
}
