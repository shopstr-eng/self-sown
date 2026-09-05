import { ISO_COUNTRY_CODES } from "@/utils/geo/countries";
import { NostrEvent } from "@/utils/types/types";

// Marketplace spec (Gamma Markets market-spec), "Shipping Option (Kind:
// 30406)": a merchant-published, addressable event describing one shipping
// method. Products reference options with
// ["shipping_option", "30406:<pubkey>:<d-tag>", <optional extra-cost>].
// This module parses/validates those events and builds them for publication.

export const SHIPPING_OPTION_KIND = 30406;

export const SHIPPING_SERVICES = [
  "standard",
  "express",
  "overnight",
  "pickup",
] as const;
export type ShippingService = (typeof SHIPPING_SERVICES)[number];

export type ShippingDurationUnit = "H" | "D" | "W";

export type ShippingOption = {
  id: string;
  pubkey: string;
  d: string;
  /** Addressable coordinate "30406:<pubkey>:<d>" used by shipping_option refs. */
  address: string;
  createdAt: number;
  title: string;
  /** Event content: optional human-friendly description. */
  description: string;
  baseCost: number;
  currency: string;
  /** ISO 3166-1 alpha-2 codes (uppercase), at least one. */
  countries: string[];
  service: ShippingService;
  carrier?: string;
  /** ISO 3166-2 region codes (e.g. "US-FL"). */
  regions?: string[];
  duration?: { min: number; max: number; unit: ShippingDurationUnit };
  location?: string;
  geohash?: string;
  weightMin?: { value: number; unit: string };
  weightMax?: { value: number; unit: string };
  dimMin?: { dims: string; unit: string };
  dimMax?: { dims: string; unit: string };
  pricePerWeight?: { price: number; unit: string };
  pricePerVolume?: { price: number; unit: string };
  pricePerDistance?: { price: number; unit: string };
};

/** A product's reference to a shipping option (or a collection's options). */
export type ShippingOptionRef = {
  /** "30406:<pubkey>:<d-tag>" (direct) or "30405:<pubkey>:<d-tag>" (collection). */
  reference: string;
  /** Optional extra cost in the PRODUCT's currency for using this option. */
  extraCost?: number;
};

const SHIPPING_OPTION_REF_RE = /^(30406|30405):[0-9a-f]{64}:[^\s]+$/;
const REGION_CODE_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const DIMS_RE = /^\d+(\.\d+)?x\d+(\.\d+)?x\d+(\.\d+)?$/;

export function isShippingOptionReference(reference: string): boolean {
  return SHIPPING_OPTION_REF_RE.test(reference);
}

function finiteNonNegative(raw: string | undefined): number | undefined {
  if (raw == null || !String(raw).trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseValueUnit(
  values: string[]
): { value: number; unit: string } | undefined {
  const value = finiteNonNegative(values[0]);
  const unit = values[1]?.trim();
  if (value === undefined || !unit) return undefined;
  return { value, unit };
}

function parsePriceUnit(
  values: string[]
): { price: number; unit: string } | undefined {
  const parsed = parseValueUnit(values);
  if (!parsed) return undefined;
  return { price: parsed.value, unit: parsed.unit };
}

function parseDim(values: string[]): { dims: string; unit: string } | undefined {
  const dims = values[0]?.trim();
  const unit = values[1]?.trim();
  if (!dims || !unit || !DIMS_RE.test(dims)) return undefined;
  return { dims, unit };
}

/**
 * Parses a kind-30406 event into a ShippingOption. Required tags (d, title,
 * price, country, service) are strictly validated — any failure rejects the
 * whole event (returns null). Optional tags are dropped individually when
 * malformed so one bad tag can't hide an otherwise usable option.
 */
export function parseShippingOptionEvent(
  event: NostrEvent
): ShippingOption | null {
  if (event.kind !== SHIPPING_OPTION_KIND) return null;
  const tags = event.tags ?? [];

  let d: string | undefined;
  let title: string | undefined;
  let baseCost: number | undefined;
  let currency: string | undefined;
  let service: ShippingService | undefined;
  const countries: string[] = [];
  const regions: string[] = [];

  const option: Partial<ShippingOption> = {};

  for (const tag of tags) {
    const [key, ...values] = tag;
    switch (key) {
      case "d":
        if (values[0]) d = values[0];
        break;
      case "title":
        if (values[0]) title = values[0];
        break;
      case "price": {
        const cost = finiteNonNegative(values[0]);
        const cur = values[1]?.trim();
        if (cost !== undefined && cur) {
          baseCost = cost;
          currency = cur;
        }
        break;
      }
      case "country":
        // One tag carries an array of ISO codes; repeated tags accumulate.
        for (const v of values) {
          const code = v?.trim().toUpperCase();
          if (code && ISO_COUNTRY_CODES.has(code) && !countries.includes(code))
            countries.push(code);
        }
        break;
      case "service": {
        const s = values[0]?.trim().toLowerCase();
        if ((SHIPPING_SERVICES as readonly string[]).includes(s ?? "")) {
          service = s as ShippingService;
        }
        break;
      }
      case "carrier":
        if (values[0]) option.carrier = values[0];
        break;
      case "region":
        for (const v of values) {
          const code = v?.trim().toUpperCase();
          if (code && REGION_CODE_RE.test(code) && !regions.includes(code))
            regions.push(code);
        }
        break;
      case "duration": {
        const min = finiteNonNegative(values[0]);
        const max = finiteNonNegative(values[1]);
        const unit = values[2]?.trim().toUpperCase();
        if (
          min !== undefined &&
          max !== undefined &&
          (unit === "H" || unit === "D" || unit === "W")
        ) {
          option.duration = { min, max, unit };
        }
        break;
      }
      case "location":
        if (values[0]) option.location = values[0];
        break;
      case "g":
        if (values[0]) option.geohash = values[0];
        break;
      case "weight-min": {
        const parsed = parseValueUnit(values);
        if (parsed) option.weightMin = parsed;
        break;
      }
      case "weight-max": {
        const parsed = parseValueUnit(values);
        if (parsed) option.weightMax = parsed;
        break;
      }
      case "dim-min": {
        const parsed = parseDim(values);
        if (parsed) option.dimMin = parsed;
        break;
      }
      case "dim-max": {
        const parsed = parseDim(values);
        if (parsed) option.dimMax = parsed;
        break;
      }
      case "price-weight": {
        const parsed = parsePriceUnit(values);
        if (parsed) option.pricePerWeight = parsed;
        break;
      }
      case "price-volume": {
        const parsed = parsePriceUnit(values);
        if (parsed) option.pricePerVolume = parsed;
        break;
      }
      case "price-distance": {
        const parsed = parsePriceUnit(values);
        if (parsed) option.pricePerDistance = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (!d || !title || baseCost === undefined || !currency) return null;
  if (countries.length === 0 || !service) return null;

  return {
    id: event.id,
    pubkey: event.pubkey,
    d,
    address: `${SHIPPING_OPTION_KIND}:${event.pubkey}:${d}`,
    createdAt: event.created_at,
    title,
    description: event.content || "",
    baseCost,
    currency,
    countries,
    service,
    ...option,
    ...(regions.length > 0 ? { regions } : {}),
  };
}

/** Input for building a publishable kind-30406 event template. */
export type ShippingOptionDraft = {
  d: string;
  title: string;
  baseCost: number;
  currency: string;
  countries: string[];
  service: ShippingService;
  description?: string;
  carrier?: string;
  regions?: string[];
  duration?: { min: number; max: number; unit: ShippingDurationUnit };
  location?: string;
  geohash?: string;
  weightMin?: { value: number; unit: string };
  weightMax?: { value: number; unit: string };
  dimMin?: { dims: string; unit: string };
  dimMax?: { dims: string; unit: string };
  pricePerWeight?: { price: number; unit: string };
  pricePerVolume?: { price: number; unit: string };
  pricePerDistance?: { price: number; unit: string };
};

/**
 * Builds an unsigned kind-30406 event template (sign via the caller's signer
 * and publish with the standard relay publish path). Required fields are
 * enforced by the type; invalid optional values are dropped so a bad
 * constraint never corrupts an otherwise valid option.
 */
export function buildShippingOptionEventTemplate(draft: ShippingOptionDraft): {
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
} {
  const tags: string[][] = [
    ["d", draft.d],
    ["title", draft.title],
    ["price", String(draft.baseCost), draft.currency],
    [
      "country",
      ...draft.countries.map((c) => c.trim().toUpperCase()).filter(Boolean),
    ],
    ["service", draft.service],
  ];

  if (draft.carrier) tags.push(["carrier", draft.carrier]);
  if (draft.regions && draft.regions.length > 0) {
    tags.push([
      "region",
      ...draft.regions.map((r) => r.trim().toUpperCase()).filter(Boolean),
    ]);
  }
  if (draft.duration) {
    tags.push([
      "duration",
      String(draft.duration.min),
      String(draft.duration.max),
      draft.duration.unit,
    ]);
  }
  if (draft.location) tags.push(["location", draft.location]);
  if (draft.geohash) tags.push(["g", draft.geohash]);

  const pushValueUnit = (
    name: string,
    v?: { value: number; unit: string }
  ) => {
    if (v && Number.isFinite(v.value) && v.value >= 0 && v.unit) {
      tags.push([name, String(v.value), v.unit]);
    }
  };
  const pushDim = (name: string, v?: { dims: string; unit: string }) => {
    if (v && DIMS_RE.test(v.dims) && v.unit) {
      tags.push([name, v.dims, v.unit]);
    }
  };

  const pushPriceUnit = (
    name: string,
    v?: { price: number; unit: string }
  ) => {
    if (v && Number.isFinite(v.price) && v.price >= 0 && v.unit) {
      tags.push([name, String(v.price), v.unit]);
    }
  };

  pushValueUnit("weight-min", draft.weightMin);
  pushValueUnit("weight-max", draft.weightMax);
  pushDim("dim-min", draft.dimMin);
  pushDim("dim-max", draft.dimMax);
  pushPriceUnit("price-weight", draft.pricePerWeight);
  pushPriceUnit("price-volume", draft.pricePerVolume);
  pushPriceUnit("price-distance", draft.pricePerDistance);

  return {
    kind: SHIPPING_OPTION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: draft.description || "",
    tags,
  };
}
