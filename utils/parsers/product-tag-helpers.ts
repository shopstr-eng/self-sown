import {
  SHIPPING_OPTIONS,
  ShippingOptionsType,
} from "@/utils/STATIC-VARIABLES";
import { parseShipsToCodes } from "@/utils/geo/countries";

export type ParsedShippingTag = {
  shippingType: ShippingOptionsType;
  shippingCost: number;
  shippingCurrency: string;
};

export function parseShippingTag(
  tag?: string[]
): ParsedShippingTag | undefined {
  // Only the modern 4-element format ["shipping", type, cost, currency] is accepted.
  // Legacy 1-value and 2-value shipping tags are intentionally ignored.
  if (!tag || tag[0] !== "shipping" || tag.length !== 4) {
    return;
  }

  const [, shippingType, rawShippingCost, shippingCurrency] = tag;

  // SHIPPING_OPTIONS acts as the allowlist for valid shipping types.
  // If a new shipping type is introduced in product data, it must also be
  // added to SHIPPING_OPTIONS in STATIC-VARIABLES, otherwise it will be
  // silently rejected here.
  if (
    !shippingType ||
    !shippingCurrency ||
    !SHIPPING_OPTIONS.includes(shippingType as ShippingOptionsType)
  ) {
    return;
  }

  if (rawShippingCost == null || !String(rawShippingCost).trim()) {
    return;
  }

  const shippingCost = Number(rawShippingCost);
  if (!Number.isFinite(shippingCost) || shippingCost < 0) {
    return;
  }

  return {
    shippingType: shippingType as ShippingOptionsType,
    shippingCost,
    shippingCurrency,
  };
}

export function parseShippingFromTags(
  tags: string[][]
): ParsedShippingTag | undefined {
  // Iterates all tags and returns the last valid shipping tag found.
  // "Last valid wins" ensures that if a product event contains both legacy
  // and modern shipping tags, the modern one (which typically appears later)
  // takes precedence. Legacy and malformed tags are skipped without error.
  let parsedShipping: ParsedShippingTag | undefined;

  for (const tag of tags) {
    if (tag[0] !== "shipping") continue;

    const parsed = parseShippingTag(tag);
    if (parsed) {
      parsedShipping = parsed;
    }
  }

  return parsedShipping;
}

export function getEffectiveShippingCost(
  shippingType?: string,
  shippingCost?: number
): number | null {
  if (!shippingType) {
    return null;
  }
  if (
    shippingType === "Free" ||
    shippingType === "Free/Pickup" ||
    shippingType === "Pickup" ||
    shippingType === "N/A"
  ) {
    return 0;
  }

  if (shippingType === "Added Cost/Pickup" && shippingCost === 0) {
    return 0;
  }

  if (
    typeof shippingCost !== "number" ||
    !Number.isFinite(shippingCost) ||
    shippingCost < 0
  ) {
    return null;
  }

  return shippingCost;
}

// Buyer-facing label for the optional per-product "handling_time" tag
// (seller's ship-out promise, in whole days).
export function formatHandlingTime(days: number): string {
  if (days <= 0) return "Ships out same day";
  if (days === 1) return "Ships out next day";
  return `Ships out in ${days} days`;
}

// Builds ["handling_time", wholeDays] from raw user/agent input, shared by the
// product form and both MCP write tools. Blank or invalid input returns
// undefined, meaning "unset" (create) / "keep existing" (update).
// NOTE: Number("") coerces to 0, so blank must be rejected before Number().
export function buildHandlingTimeTag(
  raw: string | number | undefined | null
): [string, string] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (str === "") return undefined;
  const days = Number(str);
  if (!Number.isFinite(days) || days < 0) return undefined;
  return ["handling_time", String(Math.floor(days))];
}

// Builds repeated ["ships_to", ISO] tags from raw user/agent input (array or
// comma-joined string). Unknown/blank codes are dropped; returns undefined
// when no valid codes remain — "unset" (create) / "keep existing" (update),
// the same contract as buildHandlingTimeTag.
export function buildShipsToTags(
  raw: string[] | string | undefined | null
): [string, string][] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const codes = parseShipsToCodes(list.map((v) => String(v)));
  return codes.length > 0
    ? codes.map((c): [string, string] => ["ships_to", c])
    : undefined;
}

// Returns the shared ship-out promise only when every item has the same
// defined handling time; undefined when items differ or any item lacks one.
// Used to decide between one cart-level line and per-product lines.
export function getUniformHandlingTimeDays(
  products: { handlingTimeDays?: number }[]
): number | undefined {
  if (products.length === 0) return undefined;
  const first = products[0]?.handlingTimeDays;
  if (first === undefined) return undefined;
  return products.every((p) => p.handlingTimeDays === first)
    ? first
    : undefined;
}
