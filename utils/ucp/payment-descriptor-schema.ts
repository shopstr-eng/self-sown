/**
 * Shared per-method payment-descriptor field contracts (JSON Schema draft
 * 2020-12 fragments).
 *
 * Two surfaces emit the same OrderFlowResult-derived payment descriptors:
 *  - the advertised UCP checkout-session schema
 *    (pages/api/ucp/schemas/checkout-session.json.ts), and
 *  - the MCP create-order route (pages/api/mcp/create-order.ts).
 *
 * The field definitions live ONLY here. The UCP schema composes its
 * discriminated per-method subschemas from them, and the MCP contract test
 * (__tests__/pages/api/mcp/create-order-payment-contract.test.ts) feeds the
 * route's real descriptors through MCP-flavored compositions of the same
 * fields. Rename a field in just one surface — the route OR the schema — and
 * a contract test fails; the two can no longer drift silently.
 */

export type JsonSchema = Record<string, unknown>;

export const PAYMENT_METHOD_ENUM = [
  "stripe",
  "lightning",
  "cashu",
  "fiat",
] as const;

export type PaymentDescriptorMethod = (typeof PAYMENT_METHOD_ENUM)[number];

/** if/then discriminator for one payment method inside an allOf. */
export function methodDiscriminator(
  method: PaymentDescriptorMethod
): JsonSchema {
  return {
    type: "object",
    properties: { method: { const: method } },
    required: ["method"],
  };
}

export const LIGHTNING_DESCRIPTOR_PROPERTIES: Record<string, JsonSchema> = {
  bolt11: { type: "string", description: "BOLT-11 invoice." },
  quoteId: { type: "string" },
  amount: { type: "number", description: "Invoice amount in sats." },
  currency: { const: "sats" },
  mintUrl: {
    type: "string",
    description: "Cashu mint that issued the invoice.",
  },
  verifyUrl: {
    type: "string",
    description: "Endpoint that confirms settlement.",
  },
};
export const LIGHTNING_DESCRIPTOR_REQUIRED = [
  "bolt11",
  "quoteId",
  "amount",
  "currency",
  "verifyUrl",
] as const;

export const CASHU_DESCRIPTOR_PROPERTIES: Record<string, JsonSchema> = {
  amount: { type: "number", description: "Redeemed token amount." },
  required: { type: "number", description: "Required amount." },
  change: { type: "number", description: "Change returned." },
  status: {
    const: "paid",
    description: "Cashu settles synchronously.",
  },
};
export const CASHU_DESCRIPTOR_REQUIRED = [
  "amount",
  "required",
  "change",
  "status",
] as const;

export const FIAT_DESCRIPTOR_PROPERTIES: Record<string, JsonSchema> = {
  selectedMethod: {
    type: ["string", "null"],
    description: "Buyer-chosen fiat rail, when selected.",
  },
  availableMethods: {
    type: "array",
    items: { type: "string" },
    description: "Seller's accepted fiat payment options.",
  },
  amount: { type: "number" },
  currency: { type: "string" },
  sellerContact: {
    type: "object",
    properties: {
      name: { type: ["string", "null"] },
      nip05: { type: ["string", "null"] },
    },
    required: ["name", "nip05"],
    additionalProperties: false,
  },
};
export const FIAT_DESCRIPTOR_REQUIRED = [
  "selectedMethod",
  "availableMethods",
  "amount",
  "currency",
  "sellerContact",
] as const;

export const STRIPE_ONE_TIME_DESCRIPTOR_PROPERTIES: Record<string, JsonSchema> =
  {
    // Absent or non-"subscription" on a one-time PaymentIntent descriptor.
    type: { not: { const: "subscription" } },
    amount: { type: "number" },
    currency: { type: "string" },
    paymentIntentId: { type: ["string", "null"] },
    clientSecret: { type: ["string", "null"] },
    connectedAccountId: { type: ["string", "null"] },
  };
export const STRIPE_ONE_TIME_DESCRIPTOR_REQUIRED = [
  "amount",
  "currency",
  "paymentIntentId",
  "clientSecret",
  "connectedAccountId",
] as const;

export const STRIPE_SUBSCRIPTION_DESCRIPTOR_PROPERTIES: Record<
  string,
  JsonSchema
> = {
  type: { const: "subscription" },
  subscriptionId: { type: "string" },
  frequency: { type: "string" },
  clientSecret: {
    type: ["string", "null"],
    description:
      "Null when the subscription was created without a first-payment PaymentIntent.",
  },
  customerId: { type: "string" },
  connectedAccountId: { type: "string" },
  recurringAmount: { type: "number" },
  currency: { type: "string" },
};
export const STRIPE_SUBSCRIPTION_DESCRIPTOR_REQUIRED = [
  "type",
  "subscriptionId",
  "frequency",
  "recurringAmount",
  "currency",
] as const;

export interface PaymentDescriptorComposition {
  /**
   * Emit the `method` discriminator as a const property + required field.
   * UCP descriptors always carry it; several MCP arms (lightning, stripe,
   * subscription) omit it because the envelope already says `paymentMethod`.
   */
  method?: PaymentDescriptorMethod;
  /** Shared fields this surface legitimately never emits (property dropped). */
  omit?: readonly string[];
  /** Shared fields this surface emits only sometimes (kept, not required). */
  optional?: readonly string[];
  /** Surface-specific extra fields (e.g. MCP `instructions`); still closed. */
  extraProperties?: Record<string, JsonSchema>;
  extraRequired?: readonly string[];
}

/**
 * Compose a closed (`additionalProperties:false`) per-method descriptor
 * subschema from the shared field contract plus a surface's deltas.
 */
export function composePaymentDescriptor(
  sharedProperties: Record<string, JsonSchema>,
  sharedRequired: readonly string[],
  composition: PaymentDescriptorComposition = {}
): JsonSchema {
  const omit = new Set(composition.omit ?? []);
  const optional = new Set(composition.optional ?? []);
  const properties: Record<string, JsonSchema> = {};
  if (composition.method) {
    properties.method = { const: composition.method };
  }
  for (const [key, value] of Object.entries(sharedProperties)) {
    if (!omit.has(key)) properties[key] = value;
  }
  Object.assign(properties, composition.extraProperties ?? {});
  const required = [
    ...(composition.method ? ["method"] : []),
    ...sharedRequired.filter((f) => !omit.has(f) && !optional.has(f)),
    ...(composition.extraRequired ?? []),
  ];
  return { type: "object", properties, required, additionalProperties: false };
}
