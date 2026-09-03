export const SELLER_ORDER_SUBJECTS = [
  "order-payment",
  "order-info",
  "payment-change",
  "order-receipt",
  "shipping-info",
  "order-completed",
  "zapsnag-order",
] as const;

export type SellerOrderSubject = (typeof SELLER_ORDER_SUBJECTS)[number];

export const SELLER_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "shipped",
  "completed",
  "canceled",
] as const;

export type SellerOrderStatus = (typeof SELLER_ORDER_STATUSES)[number];

export interface SellerOrderEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  read?: boolean;
  wrappedEventId?: string;
}

export interface SellerOrderMessage {
  sourceEventId: string;
  wrappedEventId?: string;
  orderId: string;
  subject: SellerOrderSubject;
  sellerPubkey: string;
  buyerPubkey?: string;
  buyerEmail?: string;
  isGuest: boolean;
  productAddress: string;
  productTitle?: string;
  quantity: number;
  amount?: number;
  currency?: string;
  status: SellerOrderStatus;
  paymentMethod?: string;
  paymentReference?: string;
  contact?: string;
  address?: string;
  pickupLocation?: string;
  selectedSize?: string;
  selectedVolume?: string;
  selectedWeight?: string;
  selectedVariant?: string;
  variantLabel?: string;
  selectedBulkOption?: number;
  carrier?: string;
  tracking?: string;
  eta?: number;
  createdAt: number;
  read: boolean;
}

export interface SellerOrderHistoryEntry {
  sourceEventId: string;
  subject: SellerOrderSubject;
  status: SellerOrderStatus;
  createdAt: number;
}

export interface SellerOrder extends Omit<
  SellerOrderMessage,
  "sourceEventId" | "wrappedEventId" | "createdAt" | "read"
> {
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  sourceEventIds: string[];
  wrappedEventIds: string[];
  history: SellerOrderHistoryEntry[];
}

export interface SellerShippingUpdate {
  carrier?: string;
  tracking?: string;
  eta?: number;
}

export interface SellerShippingValidationErrors {
  carrier?: string;
  tracking?: string;
  eta?: string;
}

export interface SellerShippingValidationResult {
  value: SellerShippingUpdate;
  errors: SellerShippingValidationErrors;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_TAGS = 128;
const MAX_TAG_PARTS = 8;
const MAX_TAG_PART_LENGTH = 8192;
const MAX_CONTENT_LENGTH = 16_384;
const MAX_AMOUNT = 1_000_000_000_000_000;
const MAX_QUANTITY = 10_000;
const MAX_ETA = 253_402_300_799;
const ORDER_SUBJECT_SET = new Set<string>(SELLER_ORDER_SUBJECTS);
const ORDER_STATUS_SET = new Set<string>(SELLER_ORDER_STATUSES);

const NEXT_SELLER_STATUS: Partial<
  Record<SellerOrderStatus, SellerOrderStatus>
> = {
  pending: "confirmed",
  confirmed: "shipped",
  shipped: "completed",
};

function isSafeBoundedText(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isValidEventShape(event: SellerOrderEvent): boolean {
  return (
    event.kind === 14 &&
    HEX_64.test(event.id) &&
    HEX_64.test(event.pubkey) &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    typeof event.content === "string" &&
    event.content.length <= MAX_CONTENT_LENGTH &&
    Array.isArray(event.tags) &&
    event.tags.length <= MAX_TAGS &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= MAX_TAG_PARTS &&
        tag.every(
          (part) =>
            typeof part === "string" && part.length <= MAX_TAG_PART_LENGTH
        )
    ) &&
    (event.wrappedEventId === undefined || HEX_64.test(event.wrappedEventId))
  );
}

function getTag(event: SellerOrderEvent, key: string): string[] | undefined {
  return event.tags.find((tag) => tag[0] === key);
}

function getTagValue(event: SellerOrderEvent, key: string): string | undefined {
  return getTag(event, key)?.[1];
}

function parseOptionalText(
  event: SellerOrderEvent,
  key: string,
  maxLength: number
): { valid: boolean; value?: string } {
  const rawValue = getTagValue(event, key);
  if (rawValue === undefined) {
    return { valid: true };
  }

  const value = rawValue.trim();
  if (!isSafeBoundedText(value, maxLength)) {
    return { valid: false };
  }

  return { valid: true, value };
}

function parseOptionalNumber(
  event: SellerOrderEvent,
  key: string,
  options: { min: number; max: number; integer?: boolean }
): { valid: boolean; value?: number } {
  const rawValue = getTagValue(event, key);
  if (rawValue === undefined) {
    return { valid: true };
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { valid: false };
  }

  const value = Number(trimmed);
  if (
    !Number.isFinite(value) ||
    value < options.min ||
    value > options.max ||
    (options.integer === true && !Number.isInteger(value))
  ) {
    return { valid: false };
  }

  return { valid: true, value };
}

function parseProductAddress(
  value: string,
  sellerPubkey: string
): string | null {
  if (value.length > 400 || CONTROL_CHARACTERS.test(value)) {
    return null;
  }

  const firstColon = value.indexOf(":");
  const secondColon = value.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    return null;
  }

  const kind = value.slice(0, firstColon);
  const merchantPubkey = value.slice(firstColon + 1, secondColon);
  const dTag = value.slice(secondColon + 1);
  if (
    kind !== "30402" ||
    merchantPubkey !== sellerPubkey ||
    !HEX_64.test(merchantPubkey) ||
    !isSafeBoundedText(dTag, 256)
  ) {
    return null;
  }

  return value;
}

function parseProductTitle(content: string): string | undefined {
  const productLine = content
    .split(/\r?\n/)
    .find((line) => /^Product(?:\/Service)?:\s*/i.test(line));
  if (!productLine) {
    return undefined;
  }

  const title = productLine.replace(/^Product(?:\/Service)?:\s*/i, "").trim();
  return isSafeBoundedText(title, 120) ? title : undefined;
}

function toSellerOrderSubject(value: string): SellerOrderSubject | null {
  return ORDER_SUBJECT_SET.has(value) ? (value as SellerOrderSubject) : null;
}

export function parseSellerOrderMessage(
  event: SellerOrderEvent,
  sellerPubkey: string
): SellerOrderMessage | null {
  if (!HEX_64.test(sellerPubkey) || !isValidEventShape(event)) {
    return null;
  }

  const recipients = event.tags
    .filter((tag) => tag[0] === "p")
    .map((tag) => tag[1]);
  if (!recipients.includes(sellerPubkey)) {
    return null;
  }

  const subjectValue = getTagValue(event, "subject");
  const subject = subjectValue ? toSellerOrderSubject(subjectValue) : null;
  const orderId = getTagValue(event, "order")?.trim() ?? "";
  if (!subject || !ORDER_ID.test(orderId)) {
    return null;
  }

  const itemTag = getTag(event, "item");
  const productAddressValue = itemTag?.[1] ?? getTagValue(event, "a") ?? "";
  const productAddress = parseProductAddress(productAddressValue, sellerPubkey);
  if (!productAddress) {
    return null;
  }

  const quantityRaw = itemTag?.[2]?.trim() || "1";
  const quantity = Number(quantityRaw);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return null;
  }

  const amount = parseOptionalNumber(event, "amount", {
    min: 0,
    max: MAX_AMOUNT,
  });
  const eta = parseOptionalNumber(event, "eta", {
    min: 1,
    max: MAX_ETA,
    integer: true,
  });
  if (!amount.valid || !eta.valid) {
    return null;
  }

  const buyerPubkeyValue = getTagValue(event, "b")?.trim();
  if (
    buyerPubkeyValue !== undefined &&
    (!HEX_64.test(buyerPubkeyValue) || buyerPubkeyValue !== event.pubkey)
  ) {
    return null;
  }
  const buyerPubkey = buyerPubkeyValue ?? event.pubkey;

  const currencyRaw = getTagValue(event, "currency")?.trim();
  if (
    currencyRaw !== undefined &&
    (!/^[A-Za-z0-9_-]{1,12}$/.test(currencyRaw) ||
      CONTROL_CHARACTERS.test(currencyRaw))
  ) {
    return null;
  }

  const textFields = {
    buyerEmail: parseOptionalText(event, "buyer_email", 254),
    contact: parseOptionalText(event, "contact", 254),
    address: parseOptionalText(event, "address", 512),
    pickupLocation: parseOptionalText(event, "pickup", 256),
    selectedSize: parseOptionalText(event, "size", 120),
    selectedVolume: parseOptionalText(event, "volume", 120),
    selectedWeight: parseOptionalText(event, "weight", 120),
    selectedVariant: parseOptionalText(event, "variant", 120),
    variantLabel: parseOptionalText(event, "variant_label", 120),
    carrier: parseOptionalText(event, "carrier", 80),
    tracking: parseOptionalText(event, "tracking", 120),
  };
  if (Object.values(textFields).some((field) => !field.valid)) {
    return null;
  }

  const bulk = parseOptionalNumber(event, "bulk", {
    min: 1,
    max: MAX_QUANTITY,
    integer: true,
  });
  if (!bulk.valid) {
    return null;
  }

  const paymentTag = getTag(event, "payment");
  const paymentMethodRaw = paymentTag?.[1]?.trim();
  const paymentReferenceRaw = paymentTag?.[2]?.trim();
  if (
    (paymentMethodRaw !== undefined &&
      !isSafeBoundedText(paymentMethodRaw, 40)) ||
    (paymentReferenceRaw !== undefined &&
      !isSafeBoundedText(paymentReferenceRaw, 8192))
  ) {
    return null;
  }

  const productTitle = parseProductTitle(event.content);

  return {
    sourceEventId: event.id,
    ...(event.wrappedEventId ? { wrappedEventId: event.wrappedEventId } : {}),
    orderId,
    subject,
    sellerPubkey,
    buyerPubkey,
    ...(textFields.buyerEmail.value
      ? { buyerEmail: textFields.buyerEmail.value }
      : {}),
    isGuest: getTagValue(event, "buyer_type")?.trim() === "guest",
    productAddress,
    ...(productTitle ? { productTitle } : {}),
    quantity,
    ...(amount.value !== undefined ? { amount: amount.value } : {}),
    ...(currencyRaw ? { currency: currencyRaw.toUpperCase() } : {}),
    // Every envelope loaded here is addressed to the seller and authored by
    // the buyer. Buyer-controlled subject/status tags cannot grant a
    // seller-managed transition; authenticated server state is applied during
    // consolidation.
    status: "pending",
    ...(paymentMethodRaw
      ? { paymentMethod: paymentMethodRaw.toLowerCase() }
      : {}),
    ...(paymentReferenceRaw ? { paymentReference: paymentReferenceRaw } : {}),
    ...(textFields.contact.value ? { contact: textFields.contact.value } : {}),
    ...(textFields.address.value ? { address: textFields.address.value } : {}),
    ...(textFields.pickupLocation.value
      ? { pickupLocation: textFields.pickupLocation.value }
      : {}),
    ...(textFields.selectedSize.value
      ? { selectedSize: textFields.selectedSize.value }
      : {}),
    ...(textFields.selectedVolume.value
      ? { selectedVolume: textFields.selectedVolume.value }
      : {}),
    ...(textFields.selectedWeight.value
      ? { selectedWeight: textFields.selectedWeight.value }
      : {}),
    ...(textFields.selectedVariant.value
      ? { selectedVariant: textFields.selectedVariant.value }
      : {}),
    ...(textFields.variantLabel.value
      ? { variantLabel: textFields.variantLabel.value }
      : {}),
    ...(bulk.value !== undefined ? { selectedBulkOption: bulk.value } : {}),
    ...(textFields.carrier.value ? { carrier: textFields.carrier.value } : {}),
    ...(textFields.tracking.value
      ? { tracking: textFields.tracking.value }
      : {}),
    ...(eta.value !== undefined ? { eta: eta.value } : {}),
    createdAt: event.created_at,
    read: event.read === true,
  };
}

export function canSellerTransitionOrderStatus(
  currentStatus: SellerOrderStatus,
  nextStatus: SellerOrderStatus
): boolean {
  return NEXT_SELLER_STATUS[currentStatus] === nextStatus;
}

export function getNextSellerOrderStatus(
  currentStatus: SellerOrderStatus
): SellerOrderStatus | null {
  return NEXT_SELLER_STATUS[currentStatus] ?? null;
}

function createHistoryEntry(
  message: SellerOrderMessage
): SellerOrderHistoryEntry {
  return {
    sourceEventId: message.sourceEventId,
    subject: message.subject,
    status: message.status,
    createdAt: message.createdAt,
  };
}

function createSellerOrder(message: SellerOrderMessage): SellerOrder {
  const { sourceEventId, wrappedEventId, createdAt, read, ...orderFields } =
    message;
  return {
    ...orderFields,
    createdAt,
    updatedAt: createdAt,
    unread: !read,
    sourceEventIds: [sourceEventId],
    wrappedEventIds: wrappedEventId ? [wrappedEventId] : [],
    history: [createHistoryEntry(message)],
  };
}

function hasConflictingIdentity(
  order: SellerOrder,
  message: SellerOrderMessage
): boolean {
  return (
    order.sellerPubkey !== message.sellerPubkey ||
    order.productAddress !== message.productAddress ||
    Boolean(
      order.buyerPubkey &&
      message.buyerPubkey &&
      order.buyerPubkey !== message.buyerPubkey
    )
  );
}

function mergeMessageIntoOrder(
  order: SellerOrder,
  message: SellerOrderMessage
): void {
  if (
    hasConflictingIdentity(order, message) ||
    order.sourceEventIds.includes(message.sourceEventId)
  ) {
    return;
  }

  const isDetailMessage =
    message.subject !== "shipping-info" &&
    message.subject !== "order-completed";

  if (!order.buyerPubkey && message.buyerPubkey) {
    order.buyerPubkey = message.buyerPubkey;
  }
  if (!order.buyerEmail && message.buyerEmail) {
    order.buyerEmail = message.buyerEmail;
  }
  order.isGuest = order.isGuest || message.isGuest;

  if (isDetailMessage) {
    order.quantity = message.quantity;
    if (message.amount !== undefined) order.amount = message.amount;
    if (message.currency) order.currency = message.currency;
    if (message.productTitle) order.productTitle = message.productTitle;
    if (message.contact) order.contact = message.contact;
    if (message.address) order.address = message.address;
    if (message.pickupLocation) order.pickupLocation = message.pickupLocation;
    if (message.selectedSize) order.selectedSize = message.selectedSize;
    if (message.selectedVolume) order.selectedVolume = message.selectedVolume;
    if (message.selectedWeight) order.selectedWeight = message.selectedWeight;
    if (message.selectedVariant)
      order.selectedVariant = message.selectedVariant;
    if (message.variantLabel) order.variantLabel = message.variantLabel;
    if (message.selectedBulkOption !== undefined)
      order.selectedBulkOption = message.selectedBulkOption;
  }

  if (message.paymentMethod) order.paymentMethod = message.paymentMethod;
  if (message.paymentReference)
    order.paymentReference = message.paymentReference;
  if (message.carrier) order.carrier = message.carrier;
  if (message.tracking) order.tracking = message.tracking;
  if (message.eta !== undefined) order.eta = message.eta;

  if (
    message.status === "canceled" ||
    message.status === order.status ||
    canSellerTransitionOrderStatus(order.status, message.status)
  ) {
    order.status = message.status;
  }

  order.updatedAt = Math.max(order.updatedAt, message.createdAt);
  order.unread = order.unread || !message.read;
  order.sourceEventIds.push(message.sourceEventId);
  if (
    message.wrappedEventId &&
    !order.wrappedEventIds.includes(message.wrappedEventId)
  ) {
    order.wrappedEventIds.push(message.wrappedEventId);
  }
  order.history.push(createHistoryEntry(message));
}

export function consolidateSellerOrders(
  messages: SellerOrderMessage[],
  authoritativeStatuses: Partial<Record<string, SellerOrderStatus>> = {}
): SellerOrder[] {
  const sortedMessages = [...messages].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sourceEventId.localeCompare(right.sourceEventId)
  );
  const orders = new Map<string, SellerOrder>();

  for (const message of sortedMessages) {
    const existing = orders.get(message.orderId);
    if (!existing) {
      orders.set(message.orderId, createSellerOrder(message));
      continue;
    }

    mergeMessageIntoOrder(existing, message);
  }

  for (const order of orders.values()) {
    const authoritativeStatus = authoritativeStatuses[order.orderId];
    if (authoritativeStatus && ORDER_STATUS_SET.has(authoritativeStatus)) {
      order.status = authoritativeStatus;
    }
  }

  return Array.from(orders.values()).sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      left.orderId.localeCompare(right.orderId)
  );
}

export function validateSellerShippingUpdate(
  input: SellerShippingUpdate
): SellerShippingValidationResult {
  const errors: SellerShippingValidationErrors = {};
  const carrier = input.carrier?.trim();
  const tracking = input.tracking?.trim();

  if (carrier) {
    if (carrier.length > 80) {
      errors.carrier = "Carrier must be 80 characters or fewer.";
    } else if (CONTROL_CHARACTERS.test(carrier)) {
      errors.carrier = "Carrier contains unsupported characters.";
    }
  }

  if (tracking) {
    if (tracking.length > 120) {
      errors.tracking = "Tracking number must be 120 characters or fewer.";
    } else if (CONTROL_CHARACTERS.test(tracking)) {
      errors.tracking = "Tracking number contains unsupported characters.";
    }
  }

  if (
    input.eta !== undefined &&
    (!Number.isInteger(input.eta) || input.eta < 1 || input.eta > MAX_ETA)
  ) {
    errors.eta = "Estimated delivery must be a valid Unix timestamp.";
  }

  if (Object.keys(errors).length > 0) {
    return { value: {}, errors };
  }

  return {
    value: {
      ...(carrier ? { carrier } : {}),
      ...(tracking ? { tracking } : {}),
      ...(input.eta !== undefined ? { eta: input.eta } : {}),
    },
    errors,
  };
}
