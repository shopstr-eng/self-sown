import { Filter } from "nostr-tools";
import { NostrEvent } from "@/utils/types/types";
import { NostrManager } from "@/utils/nostr/nostr-manager";
import {
  SHIPPING_OPTION_KIND,
  ShippingOption,
  isShippingOptionReference,
  parseShippingOptionEvent,
} from "@/utils/parsers/shipping-option-parser";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import { ISO_COUNTRY_CODES } from "@/utils/geo/countries";
import locationSelection from "../../public/locationSelection.json";

// Fetches and resolves kind-30406 shipping option events (marketplace spec).
// Options are addressable ("30406:<pubkey>:<d>") and mutable, so every fetch
// dedups to the LATEST event per address.

/** A shipping option attached to a product, with any product-level surcharge. */
export type ResolvedShippingOption = {
  option: ShippingOption;
  /** Extra cost in the PRODUCT's currency, from the shipping_option tag. */
  extraCost?: number;
};

function mergeLatest(
  map: Map<string, ShippingOption>,
  event: NostrEvent
): void {
  const parsed = parseShippingOptionEvent(event);
  if (!parsed) return;
  const existing = map.get(parsed.address);
  if (!existing || parsed.createdAt >= existing.createdAt) {
    map.set(parsed.address, parsed);
  }
}

/**
 * Fetches the kind-30406 events for the given addressable references
 * ("30406:<pubkey>:<d>"). Collection refs ("30405:...") are not shipping
 * options themselves and are skipped. Returns a map keyed by full address.
 * Never rejects — relay failures yield whatever was fetched (possibly empty).
 */
export async function fetchShippingOptionsByAddresses(
  nostr: NostrManager,
  relays: string[],
  references: string[]
): Promise<Map<string, ShippingOption>> {
  const result = new Map<string, ShippingOption>();
  const coords = references
    .map((r) => r.trim())
    .filter((r) => isShippingOptionReference(r) && r.startsWith("30406:"))
    .map((r) => {
      const [, pubkey, d] = r.split(":");
      return { pubkey: pubkey!, d: d! };
    });
  if (coords.length === 0) return result;

  // One filter per author keeps relays happy; #d narrows to the wanted options.
  const byAuthor = new Map<string, Set<string>>();
  for (const { pubkey, d } of coords) {
    if (!byAuthor.has(pubkey)) byAuthor.set(pubkey, new Set());
    byAuthor.get(pubkey)!.add(d);
  }
  const filters: Filter[] = Array.from(byAuthor.entries()).map(
    ([author, ds]) => ({
      kinds: [SHIPPING_OPTION_KIND],
      authors: [author],
      "#d": Array.from(ds),
    })
  );

  try {
    const events = await nostr.fetch(filters, {}, relays);
    for (const event of events) mergeLatest(result, event);
  } catch (error) {
    console.error("Failed to fetch shipping options:", error);
  }
  return result;
}

/**
 * Fetches every kind-30406 shipping option a seller has published (latest per
 * d-tag). Used by the seller's own management UI. Never rejects.
 */
export async function fetchShippingOptionsForSeller(
  nostr: NostrManager,
  relays: string[],
  sellerPubkey: string
): Promise<Map<string, ShippingOption>> {
  const result = new Map<string, ShippingOption>();
  try {
    const events = await nostr.fetch(
      [{ kinds: [SHIPPING_OPTION_KIND], authors: [sellerPubkey] }],
      {},
      relays
    );
    for (const event of events) mergeLatest(result, event);
  } catch (error) {
    console.error("Failed to fetch seller shipping options:", error);
  }
  return result;
}

/**
 * Resolves a product's shipping_option refs against fetched options, in the
 * product's listed order. Unknown/unfetched refs and collection refs are
 * skipped (callers fall back to the legacy `shipping` tag behavior).
 */
export function resolveProductShippingOptions(
  product: ProductData,
  optionsByAddress: Map<string, ShippingOption>
): ResolvedShippingOption[] {
  const resolved: ResolvedShippingOption[] = [];
  for (const ref of product.shippingOptions ?? []) {
    if (!ref.reference.startsWith("30406:")) continue;
    const option = optionsByAddress.get(ref.reference);
    if (option) {
      resolved.push(
        ref.extraCost !== undefined
          ? { option, extraCost: ref.extraCost }
          : { option }
      );
    }
  }
  return resolved;
}

/** Convenience: fetch + resolve for one or more products in a single pass. */
export async function fetchAndResolveShippingOptions(
  nostr: NostrManager,
  relays: string[],
  products: ProductData[]
): Promise<Map<string, ResolvedShippingOption[]>> {
  const refs: string[] = [];
  for (const product of products) {
    for (const ref of product.shippingOptions ?? []) refs.push(ref.reference);
  }
  const options = await fetchShippingOptionsByAddresses(nostr, relays, refs);
  const resolved = new Map<string, ResolvedShippingOption[]>();
  for (const product of products) {
    resolved.set(product.id, resolveProductShippingOptions(product, options));
  }
  return resolved;
}

/** Total buyer-facing cost of a resolved option: base + product surcharge. */
export function resolvedOptionCost(resolved: ResolvedShippingOption): number {
  return resolved.option.baseCost + (resolved.extraCost ?? 0);
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  (locationSelection.countries as { country: string; iso3166: string }[]).map(
    (c) => [c.country.trim().toUpperCase(), c.iso3166.trim().toUpperCase()]
  )
);

// Common display variants not present verbatim in locationSelection.json.
const COUNTRY_ALIASES: Record<string, string> = {
  USA: "US",
  "UNITED STATES": "US",
  UK: "GB",
};

/**
 * Best-effort normalization of a buyer-form country value to ISO 3166-1
 * alpha-2. Buyer address forms store country NAMES ("United States of
 * America") while spec shipping options carry CODES ("US"). Returns "" when
 * unmappable — callers must treat that as "cannot evaluate eligibility",
 * never as "ineligible".
 */
export function toCountryCode(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (!v) return "";
  if (ISO_COUNTRY_CODES.has(v)) return v;
  if (COUNTRY_ALIASES[v]) return COUNTRY_ALIASES[v];
  return COUNTRY_NAME_TO_CODE[v] ?? "";
}

/**
 * Destination filter for spec shipping options (the spec makes `country`
 * required, so every parsed option has one). When the buyer's country is
 * unknown/unmappable, ALL options stay eligible — we can't evaluate yet.
 * Region/weight/dimension constraints are deliberately advisory here: the
 * seller confirms final eligibility at fulfillment, and rejecting early
 * would block legitimate orders over approximate form data.
 */
export function eligibleShippingOptions(
  options: ResolvedShippingOption[],
  buyerCountry?: string
): ResolvedShippingOption[] {
  const code = buyerCountry ? toCountryCode(buyerCountry) : "";
  if (!code) return options;
  return options.filter((r) => r.option.countries.includes(code));
}

/**
 * Hard destination block: the product declares spec shipping options and the
 * buyer entered a mappable country, but NO option serves it. Falling back to
 * the legacy/live shipping cost here would defeat the seller's declared
 * destination restriction, so checkout must be blocked instead. Returns false
 * while the country is unknown/unmappable (cannot evaluate ≠ blocked).
 */
export function isSpecDestinationBlocked(
  resolvedCount: number,
  buyerCountry: string | undefined,
  visibleCount: number
): boolean {
  if (resolvedCount === 0 || visibleCount > 0) return false;
  if (!buyerCountry || !buyerCountry.trim()) return false;
  return toCountryCode(buyerCountry) !== "";
}
