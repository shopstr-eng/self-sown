import type { ProductFormValues } from "@/utils/types/types";
import CryptoJS from "crypto-js";

// Catalog shapes returned by utils/square/square-api.ts#fetchSquareCatalog. They
// live here (a pure, server-free module) so both the server fetch and the
// client import modal can share one source of truth without the modal pulling
// in any server-only Square code.
export interface SquareCatalogVariation {
  id: string;
  name: string | null;
  // Integer amount in the smallest currency unit (cents for USD, whole for JPY).
  priceAmount: number | null;
  priceCurrency: string | null;
  sku: string | null;
}

export interface SquareCatalogItem {
  id: string;
  name: string | null;
  description: string | null;
  imageUrls: string[];
  variations: SquareCatalogVariation[];
  isArchived: boolean;
}

export interface SquareMigrationOptions {
  pubkey: string;
  relayHint: string;
  defaultCurrency: string;
  defaultCategory: string;
  defaultLocation: string;
  defaultShippingOption: string;
  defaultShippingCost: string;
  pickupLocations?: string[];
  /** Whether to import archived Square items too, or only active ones. */
  includeArchived?: boolean;
}

export interface BuiltSquareListing {
  item: SquareCatalogItem;
  values: ProductFormValues;
  warnings: string[];
}

// ISO 4217 currencies with no minor unit. Square reports money in the smallest
// unit, so these convert 1:1 while everything else divides by 100.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const currencyDecimals = (currency: string): number =>
  ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;

const minorToMajor = (amount: number, currency: string): number => {
  const decimals = currencyDecimals(currency);
  return decimals === 0 ? amount : amount / 10 ** decimals;
};

const stripHtml = (html: string): string => {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const isHttpImage = (url: string): boolean => {
  if (!url) return false;
  return /^https?:\/\//i.test(url) && !url.includes(" ");
};

/**
 * Build the ProductFormValues array (NIP-99 kind 30402 tags) for a single
 * Square catalog item. Returns warnings for things that could not be mapped.
 *
 * Square's catalog/list carries no inventory counts, so we publish each item as
 * a single in-stock listing (no `quantity` tag — that matches the Shopify
 * importer's "untracked => in stock" behaviour) and intentionally do NOT emit
 * per-variation `size` tags: a size tag requires a stock number we don't have,
 * and emitting 0 would mark every variant out of stock. When an item has
 * multiple priced variations we warn the seller so they can add variants by
 * hand after import.
 */
export function buildListingFromSquareItem(
  item: SquareCatalogItem,
  options: SquareMigrationOptions
): BuiltSquareListing {
  const warnings: string[] = [];
  const {
    pubkey,
    relayHint,
    defaultCurrency,
    defaultCategory,
    defaultLocation,
    defaultShippingOption,
    defaultShippingCost,
    pickupLocations,
  } = options;

  const title = (item.name || "").trim() || "Untitled Square item";
  const description = stripHtml(item.description || "") || title;

  // d-tag: stable hash of title (matches existing product-form behaviour).
  const dTag = CryptoJS.SHA256(title).toString(CryptoJS.enc.Hex);

  // Pick the canonical price: first variation with a positive price, else 0.
  const pricedVariations = item.variations.filter(
    (v) => typeof v.priceAmount === "number" && (v.priceAmount as number) > 0
  );
  const firstPriced = pricedVariations[0];
  const currency = (
    firstPriced?.priceCurrency || defaultCurrency
  ).toUpperCase();
  const decimals = currencyDecimals(currency);
  const price = firstPriced
    ? minorToMajor(firstPriced.priceAmount as number, currency)
    : 0;
  if (!firstPriced) {
    warnings.push(
      `"${title}": no priced variation found, defaulting to 0 ${currency}.`
    );
  }

  // Warn when variations span a real price range — a Milk Market listing
  // carries a single price, so the seller should know which one we picked.
  const majorPrices = pricedVariations
    .map((v) =>
      minorToMajor(v.priceAmount as number, v.priceCurrency || currency)
    )
    .filter((n) => Number.isFinite(n) && n > 0);
  if (majorPrices.length > 1) {
    const min = Math.min(...majorPrices);
    const max = Math.max(...majorPrices);
    if (max - min > 0.01) {
      warnings.push(
        `"${title}": Square variations range from ${min.toFixed(decimals)} to ${max.toFixed(decimals)} ${currency}; the listing will use ${price.toFixed(decimals)} ${currency}. Edit the listing if you'd prefer a different price or add variants by hand.`
      );
    } else {
      warnings.push(
        `"${title}": has multiple Square variations; only a single price/listing is imported. Add variants by hand after import if you need them.`
      );
    }
  }

  // Validate images.
  const validImages = item.imageUrls.filter(isHttpImage);
  if (validImages.length === 0) {
    warnings.push(
      `"${title}": no public image URLs found in the catalog. The listing will be created without images and you will need to add them manually before publishing.`
    );
  }

  const mmStatus = item.isArchived ? "inactive" : "active";
  const shippingOption = defaultShippingOption;

  const tags: ProductFormValues = [
    ["d", dTag],
    ["alt", "Product listing: " + title],
    ["client", "Milk Market", "31990:" + pubkey + ":" + dTag, relayHint],
    ["title", title],
    ["summary", description],
    ["price", price.toFixed(decimals), currency],
    ["location", defaultLocation],
    [
      "shipping",
      shippingOption,
      shippingOption === "Added Cost" || shippingOption === "Added Cost/Pickup"
        ? defaultShippingCost || "0"
        : "0",
      currency,
    ],
  ];

  validImages.forEach((img) => tags.push(["image", img]));

  if (defaultCategory) tags.push(["t", defaultCategory]);
  tags.push(["t", "MilkMarket"]);
  tags.push(["t", "FREEMILK"]);

  tags.push(["status", mmStatus]);

  if (
    pickupLocations &&
    pickupLocations.length > 0 &&
    (shippingOption === "Pickup" ||
      shippingOption === "Free/Pickup" ||
      shippingOption === "Added Cost/Pickup")
  ) {
    pickupLocations
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((loc) => tags.push(["pickup_location", loc]));
  }

  return { item, values: tags, warnings };
}

export function buildListingsFromSquareItems(
  items: SquareCatalogItem[],
  options: SquareMigrationOptions
): BuiltSquareListing[] {
  const filtered = options.includeArchived
    ? items
    : items.filter((i) => !i.isArchived);
  return filtered.map((i) => buildListingFromSquareItem(i, options));
}
