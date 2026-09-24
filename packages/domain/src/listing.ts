import { CATEGORIES, type ShippingOptionsType } from "./constants";
import type { ProductFormValue, ProductFormValues } from "./forms";
import type { NostrEventRecord } from "./seller";
import { normalizeSellerParcel, type SellerParcel } from "./shipping";

export type SellerListingStatus = "active" | "inactive";

export interface SellerListingDraft {
  eventId?: string;
  dTag?: string;
  sourceCreatedAt?: number;
  sourceTags?: ProductFormValues;
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
  shipFromPostalCode?: string;
  shipFromCountry?: string;
  packageWeightOz?: string;
  packageLengthIn?: string;
  packageWidthIn?: string;
  packageHeightIn?: string;
  handlingTimeDays?: string;
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
  shipFromPostalCode?: string;
  shipFromCountry?: string;
  packageWeightOz?: string;
  packageLengthIn?: string;
  packageWidthIn?: string;
  packageHeightIn?: string;
  handlingTimeDays?: string;
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
  shipFromPostalCode: string;
  shipFromCountry: string;
  parcel?: SellerParcel;
  handlingTimeDays?: number;
  quantity?: number;
  status: SellerListingStatus;
}

const RESERVED_MARKETPLACE_TAGS = new Set([
  "SelfSown",
  // Pre-rebrand listings carry the legacy MilkMarket tag; keep it reserved so
  // old events don't leak it into the user-facing category list.
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
const MOBILE_EDITABLE_TAGS = new Set([
  "d",
  "alt",
  "client",
  "title",
  "summary",
  "price",
  "location",
  "shipping",
  "status",
  "image",
  "t",
  "quantity",
  "pickup_location",
  "ship_from_zip",
  "parcel",
  "handling_time",
  "published_at",
]);

export function hasSellerListingShippingOptions(
  draft: SellerListingDraft
): boolean {
  // Preserve even unresolved refs: a relay outage must not change fulfillment.
  return draft.sourceTags?.some((tag) => tag[0] === "shipping_option") ?? false;
}

function getTagValues(event: NostrEventRecord, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

function cloneTags(tags: string[][]): ProductFormValues {
  return tags.flatMap((tag): ProductFormValue[] => {
    const [key, ...values] = tag;
    return key ? [[key, ...values]] : [];
  });
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
    shipFromPostalCode: "",
    shipFromCountry: "US",
    packageWeightOz: "",
    packageLengthIn: "",
    packageWidthIn: "",
    packageHeightIn: "",
    handlingTimeDays: "",
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
  const parcel = normalizeSellerParcel({
    weightOz: draft.packageWeightOz ?? "",
    lengthIn: draft.packageLengthIn ?? "",
    widthIn: draft.packageWidthIn ?? "",
    heightIn: draft.packageHeightIn ?? "",
  });
  const parsedHandlingTime = parseNumberInput(draft.handlingTimeDays ?? "");

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
    shipFromPostalCode: (draft.shipFromPostalCode ?? "").trim(),
    shipFromCountry:
      (draft.shipFromCountry ?? "US").trim().toUpperCase() || "US",
    ...(parcel ? { parcel } : {}),
    ...(parsedHandlingTime !== null &&
    Number.isInteger(parsedHandlingTime) &&
    parsedHandlingTime >= 0
      ? { handlingTimeDays: parsedHandlingTime }
      : {}),
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
  const packageValues = [
    draft.packageWeightOz ?? "",
    draft.packageLengthIn ?? "",
    draft.packageWidthIn ?? "",
    draft.packageHeightIn ?? "",
  ];
  const hasPackageInput = packageValues.some((value) => value.trim() !== "");
  const parcel = normalizeSellerParcel({
    weightOz: draft.packageWeightOz ?? "",
    lengthIn: draft.packageLengthIn ?? "",
    widthIn: draft.packageWidthIn ?? "",
    heightIn: draft.packageHeightIn ?? "",
  });
  const handlingTimeInput = parseNumberInput(draft.handlingTimeDays ?? "");

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

  const shippingManagedOnWeb = hasSellerListingShippingOptions(draft);
  if (!shippingManagedOnWeb && !draft.shippingType) {
    errors.shippingType = "Select a shipping option.";
  }

  if (!shippingManagedOnWeb && requiresShippingCost(draft.shippingType)) {
    if (shippingCostInput === null || shippingCostInput < 0) {
      errors.shippingCost = "Enter a valid shipping cost.";
    }
  }

  if ((draft.shipFromPostalCode ?? "").length > 20) {
    errors.shipFromPostalCode =
      "Ship-from postal code must be 20 characters or fewer.";
  }
  if (!/^[A-Za-z]{2,3}$/.test((draft.shipFromCountry ?? "US").trim())) {
    errors.shipFromCountry = "Enter a valid 2- or 3-letter country code.";
  }
  if (hasPackageInput && !parcel) {
    const weight = parseNumberInput(draft.packageWeightOz ?? "");
    if (weight === null || weight <= 0) {
      errors.packageWeightOz = "Package weight must be greater than zero.";
    }
    for (const [field, value] of [
      ["packageLengthIn", draft.packageLengthIn ?? ""],
      ["packageWidthIn", draft.packageWidthIn ?? ""],
      ["packageHeightIn", draft.packageHeightIn ?? ""],
    ] as const) {
      const parsed = parseNumberInput(value);
      if (value.trim() && (parsed === null || parsed <= 0)) {
        errors[field] = "Package dimensions must be greater than zero.";
      }
    }
  }
  if (
    (draft.handlingTimeDays ?? "").trim() &&
    (handlingTimeInput === null ||
      !Number.isInteger(handlingTimeInput) ||
      handlingTimeInput < 0 ||
      handlingTimeInput > 365)
  ) {
    errors.handlingTimeDays = "Handling time must be a whole number of days.";
  }

  if (
    !shippingManagedOnWeb &&
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
  const shipFromTag = event.tags.find((tag) => tag[0] === "ship_from_zip");
  const parcelTag = event.tags.find((tag) => tag[0] === "parcel");
  const handlingTime = getTagValues(event, "handling_time")[0] ?? "";

  return {
    eventId: event.id,
    dTag,
    // Postgres bigint columns arrive as strings in cached API responses.
    sourceCreatedAt: Number(event.created_at),
    sourceTags: cloneTags(event.tags),
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
    shipFromPostalCode: shipFromTag?.[1]?.trim() ?? "",
    shipFromCountry: shipFromTag?.[2]?.trim().toUpperCase() || "US",
    packageWeightOz: parcelTag?.[1]?.trim() ?? "",
    packageLengthIn: parcelTag?.[2]?.trim() ?? "",
    packageWidthIn: parcelTag?.[3]?.trim() ?? "",
    packageHeightIn: parcelTag?.[4]?.trim() ?? "",
    handlingTimeDays: handlingTime.trim(),
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
  const shippingManagedOnWeb = hasSellerListingShippingOptions(params.draft);
  const preservedTags = cloneTags(
    (params.draft.sourceTags ?? []).filter(
      (tag) =>
        !MOBILE_EDITABLE_TAGS.has(tag[0]) ||
        (shippingManagedOnWeb &&
          (tag[0] === "shipping" || tag[0] === "pickup_location"))
    )
  );
  const tags: ProductFormValues = [
    ...preservedTags,
    ["d", params.dTag],
    ["alt", `Product listing: ${normalized.title}`],
    ["client", "Self-sown", `31990:${params.pubkey}:${params.dTag}`, relayHint],
    ["title", normalized.title],
    ["summary", normalized.description],
    ["price", String(normalized.price), normalized.currency],
    ["location", normalized.location],
    ...(!shippingManagedOnWeb
      ? [
          [
            "shipping",
            normalized.shippingType,
            String(normalized.shippingCost),
            normalized.currency,
          ] satisfies ProductFormValue,
        ]
      : []),
    ["status", normalized.status],
  ];

  if (normalized.shipFromPostalCode) {
    tags.push([
      "ship_from_zip",
      normalized.shipFromPostalCode,
      normalized.shipFromCountry,
    ]);
  }
  if (normalized.parcel) {
    const parcelTag: ProductFormValue = [
      "parcel",
      String(normalized.parcel.weightOz),
    ];
    const dimensions = [
      normalized.parcel.lengthIn,
      normalized.parcel.widthIn,
      normalized.parcel.heightIn,
    ];
    dimensions.forEach((value) => parcelTag.push(value ? String(value) : ""));
    while (parcelTag.at(-1) === "") parcelTag.pop();
    tags.push(parcelTag);
  }
  if (normalized.handlingTimeDays !== undefined) {
    tags.push(["handling_time", String(normalized.handlingTimeDays)]);
  }

  normalized.images.forEach((image) => {
    tags.push(["image", image]);
  });

  normalized.categories.forEach((category) => {
    tags.push(["t", category]);
  });
  tags.push(["t", "SelfSown"]);
  tags.push(["t", "FREEMILK"]);

  if (
    normalized.categories.some((category) => category.toLowerCase() === "beef")
  ) {
    tags.push(["t", "SAVEBEEF"]);
  }

  if (typeof normalized.quantity === "number") {
    tags.push(["quantity", String(normalized.quantity)]);
  }

  if (
    !shippingManagedOnWeb &&
    isPickupShippingOption(normalized.shippingType)
  ) {
    normalized.pickupLocations.forEach((location) => {
      tags.push(["pickup_location", location]);
    });
  }

  return tags;
}

export function getKnownSellerListingCategories(): string[] {
  return [...CATEGORIES];
}
