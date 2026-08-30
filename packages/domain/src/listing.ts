import { CATEGORIES, type ShippingOptionsType } from "./constants";
import type { ProductFormValues } from "./forms";
import type { NostrEventRecord } from "./seller";

export type SellerListingStatus = "active" | "inactive";

export interface SellerListingDraft {
  eventId?: string;
  dTag?: string;
  title: string;
  description: string;
  images: string[];
  price: string;
  currency: string;
  categories: string[];
  location: string;
  shippingType: ShippingOptionsType;
  shippingCost: string;
  pickupLocations: string[];
  quantity: string;
  status: SellerListingStatus;
}

export interface SellerListingDraftValidationErrors {
  title?: string;
  description?: string;
  images?: string;
  price?: string;
  currency?: string;
  categories?: string;
  location?: string;
  shippingType?: string;
  shippingCost?: string;
  pickupLocations?: string;
  quantity?: string;
  status?: string;
}

export interface NormalizedSellerListingDraft {
  title: string;
  description: string;
  images: string[];
  price: number;
  currency: string;
  categories: string[];
  location: string;
  shippingType: ShippingOptionsType;
  shippingCost: number;
  pickupLocations: string[];
  quantity?: number;
  status: SellerListingStatus;
}

const RESERVED_MARKETPLACE_TAGS = new Set([
  "MilkMarket",
  "FREEMILK",
  "SAVEBEEF",
]);
const PICKUP_SHIPPING_OPTIONS = new Set<ShippingOptionsType>([
  "Pickup",
  "Free/Pickup",
  "Added Cost/Pickup",
]);
const SHIPPING_COST_OPTIONS = new Set<ShippingOptionsType>([
  "Added Cost",
  "Added Cost/Pickup",
]);
const SELLER_LISTING_STATUSES = new Set<SellerListingStatus>([
  "active",
  "inactive",
]);

function getTagValues(event: NostrEventRecord, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

function normalizeCommaSeparatedValues(values: string | string[]): string[] {
  const input = Array.isArray(values) ? values : values.split(",");

  return Array.from(
    new Set(
      input.map((value) => value.trim()).filter((value) => value.length > 0)
    )
  );
}

function parseNumberInput(input: string): number | null {
  const normalized = input.trim().replace(/,/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function createEmptySellerListingDraft(): SellerListingDraft {
  return {
    title: "",
    description: "",
    images: [],
    price: "",
    currency: "USD",
    categories: [],
    location: "",
    shippingType: "Free",
    shippingCost: "",
    pickupLocations: [],
    quantity: "",
    status: "active",
  };
}

export function normalizeSellerListingCategories(
  categories: string | string[]
): string[] {
  return normalizeCommaSeparatedValues(categories);
}

export function normalizeSellerPickupLocations(
  locations: string | string[]
): string[] {
  return normalizeCommaSeparatedValues(locations);
}

export function isPickupShippingOption(
  shippingType: ShippingOptionsType
): boolean {
  return PICKUP_SHIPPING_OPTIONS.has(shippingType);
}

export function requiresShippingCost(
  shippingType: ShippingOptionsType
): boolean {
  return SHIPPING_COST_OPTIONS.has(shippingType);
}

export function normalizeSellerListingDraft(
  draft: SellerListingDraft
): NormalizedSellerListingDraft {
  const categories = normalizeSellerListingCategories(draft.categories);
  const pickupLocations = isPickupShippingOption(draft.shippingType)
    ? normalizeSellerPickupLocations(draft.pickupLocations)
    : [];
  const parsedPrice = parseNumberInput(draft.price) ?? 0;
  const parsedShippingCost = requiresShippingCost(draft.shippingType)
    ? (parseNumberInput(draft.shippingCost) ?? 0)
    : 0;
  const parsedQuantity = parseNumberInput(draft.quantity);

  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    images: Array.from(
      new Set(
        draft.images
          .map((image) => image.trim())
          .filter((image) => image.length > 0)
      )
    ),
    price: parsedPrice,
    currency: draft.currency.trim().toUpperCase(),
    categories,
    location: draft.location.trim(),
    shippingType: draft.shippingType,
    shippingCost: parsedShippingCost,
    pickupLocations,
    ...(parsedQuantity !== null && parsedQuantity >= 0
      ? { quantity: Math.floor(parsedQuantity) }
      : {}),
    status: SELLER_LISTING_STATUSES.has(draft.status) ? draft.status : "active",
  };
}

export function validateSellerListingDraft(
  draft: SellerListingDraft
): SellerListingDraftValidationErrors {
  const errors: SellerListingDraftValidationErrors = {};
  const normalized = normalizeSellerListingDraft(draft);
  const priceInput = parseNumberInput(draft.price);
  const shippingCostInput = parseNumberInput(draft.shippingCost);
  const quantityInput = parseNumberInput(draft.quantity);

  if (!normalized.title) {
    errors.title = "Listing title is required.";
  } else if (normalized.title.length > 80) {
    errors.title = "Listing title must be 80 characters or fewer.";
  }

  if (!normalized.description) {
    errors.description = "Listing description is required.";
  } else if (normalized.description.length > 1000) {
    errors.description =
      "Listing description must be 1000 characters or fewer.";
  }

  if (normalized.images.length === 0) {
    errors.images = "Add at least one listing image.";
  }

  if (priceInput === null || priceInput <= 0) {
    errors.price = "Enter a valid listing price.";
  }

  if (!normalized.currency || normalized.currency.length < 3) {
    errors.currency = "Enter a valid currency code.";
  }

  if (normalized.categories.length === 0) {
    errors.categories = "Add at least one category tag.";
  }

  if (!normalized.location) {
    errors.location = "Location is required.";
  }

  if (!draft.shippingType) {
    errors.shippingType = "Select a shipping option.";
  }

  if (requiresShippingCost(draft.shippingType)) {
    if (shippingCostInput === null || shippingCostInput < 0) {
      errors.shippingCost = "Enter a valid shipping cost.";
    }
  }

  if (
    isPickupShippingOption(draft.shippingType) &&
    normalized.pickupLocations.length === 0
  ) {
    errors.pickupLocations = "Add at least one pickup location.";
  }

  if (draft.quantity.trim()) {
    if (
      quantityInput === null ||
      quantityInput < 0 ||
      !Number.isInteger(quantityInput)
    ) {
      errors.quantity = "Quantity must be a whole number.";
    }
  }

  if (!SELLER_LISTING_STATUSES.has(draft.status)) {
    errors.status = "Select a valid listing status.";
  }

  return errors;
}

export function createSellerListingDraftFromEvent(
  event: NostrEventRecord
): SellerListingDraft | null {
  if (event.kind !== 30402) {
    return null;
  }

  const priceTag = event.tags.find((tag) => tag[0] === "price");
  const shippingTag = event.tags.find((tag) => tag[0] === "shipping");
  const dTag = getTagValues(event, "d")[0];
  const categories = getTagValues(event, "t").filter(
    (category) => !RESERVED_MARKETPLACE_TAGS.has(category)
  );
  const shippingType =
    shippingTag && typeof shippingTag[1] === "string"
      ? (shippingTag[1] as ShippingOptionsType)
      : "Free";
  const shippingCost =
    shippingTag && typeof shippingTag[2] === "string" ? shippingTag[2] : "";
  const quantity = getTagValues(event, "quantity")[0] ?? "";
  const status =
    getTagValues(event, "status")[0] === "inactive" ? "inactive" : "active";

  return {
    eventId: event.id,
    dTag,
    title: getTagValues(event, "title")[0] ?? "",
    description:
      getTagValues(event, "summary")[0] ??
      (typeof event.content === "string" ? event.content : ""),
    images: getTagValues(event, "image"),
    price: priceTag && typeof priceTag[1] === "string" ? priceTag[1] : "",
    currency: priceTag && typeof priceTag[2] === "string" ? priceTag[2] : "USD",
    categories,
    location: getTagValues(event, "location")[0] ?? "",
    shippingType,
    shippingCost,
    pickupLocations: getTagValues(event, "pickup_location"),
    quantity,
    status,
  };
}

export function buildSellerListingTags(params: {
  draft: SellerListingDraft;
  pubkey: string;
  dTag: string;
  relayHint?: string;
}): ProductFormValues {
  const normalized = normalizeSellerListingDraft(params.draft);
  const relayHint = params.relayHint ?? "";
  const tags: ProductFormValues = [
    ["d", params.dTag],
    ["alt", `Product listing: ${normalized.title}`],
    [
      "client",
      "Milk Market",
      `31990:${params.pubkey}:${params.dTag}`,
      relayHint,
    ],
    ["title", normalized.title],
    ["summary", normalized.description],
    ["price", String(normalized.price), normalized.currency],
    ["location", normalized.location],
    [
      "shipping",
      normalized.shippingType,
      String(normalized.shippingCost),
      normalized.currency,
    ],
    ["status", normalized.status],
  ];

  normalized.images.forEach((image) => {
    tags.push(["image", image]);
  });

  normalized.categories.forEach((category) => {
    tags.push(["t", category]);
  });
  tags.push(["t", "MilkMarket"]);
  tags.push(["t", "FREEMILK"]);

  if (
    normalized.categories.some((category) => category.toLowerCase() === "beef")
  ) {
    tags.push(["t", "SAVEBEEF"]);
  }

  if (typeof normalized.quantity === "number") {
    tags.push(["quantity", String(normalized.quantity)]);
  }

  if (isPickupShippingOption(normalized.shippingType)) {
    normalized.pickupLocations.forEach((location) => {
      tags.push(["pickup_location", location]);
    });
  }

  return tags;
}

export function getKnownSellerListingCategories(): string[] {
  return [...CATEGORIES];
}
