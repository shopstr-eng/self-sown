import type { NextApiRequest, NextApiResponse } from "next";
import { deriveBaseUrl } from "@/utils/ucp/seller-host";

/**
 * GET /api/ucp/schemas/checkout-session.json — JSON Schema (draft 2020-12) for
 * the checkout session object returned by /api/ucp/checkout/sessions. The UCP
 * discovery profile points its checkout capability `schema` at this URL. It
 * mirrors the shape produced by `formatCheckoutSession` in
 * utils/ucp/checkout-store.ts.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const base = deriveBaseUrl(req);

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/api/ucp/schemas/checkout-session.json`,
    title: "UCP Checkout Session",
    description:
      "A checkout session wrapping a Self-sown order. Its status is reconciled against the canonical order payment status; there is no parallel order state machine.",
    type: "object",
    $defs: {
      pubkeyRef: {
        type: "object",
        properties: { pubkey: { type: "string" } },
        required: ["pubkey"],
        additionalProperties: false,
      },
      message: {
        type: "object",
        description: "A human/agent-readable timeline entry.",
        properties: {
          type: { type: "string" },
          text: { type: "string" },
          at: { type: "string", format: "date-time" },
          severity: {
            type: "string",
            enum: ["info", "warning", "error"],
            description: "Triage hint; present on warnings/errors.",
          },
        },
        required: ["type", "text", "at"],
        additionalProperties: false,
      },
    },
    properties: {
      id: { type: "string", description: "Session id (ucp_cs_…)." },
      status: {
        type: "string",
        description:
          "UCP checkout lifecycle: incomplete → ready_for_complete → complete_in_progress → completed, plus requires_escalation and canceled.",
        enum: [
          "incomplete",
          "ready_for_complete",
          "complete_in_progress",
          "completed",
          "requires_escalation",
          "canceled",
        ],
      },
      buyer: { $ref: "#/$defs/pubkeyRef" },
      seller: { $ref: "#/$defs/pubkeyRef" },
      productId: { type: "string" },
      orderId: {
        type: "string",
        description:
          "Underlying Self-sown order id, when an order was created.",
      },
      paymentMethod: {
        type: "string",
        enum: ["stripe", "lightning", "cashu", "fiat"],
      },
      amount: { type: "number", description: "Order total in major units." },
      currency: { type: "string" },
      payment: {
        description:
          "Method-specific payment descriptor written by describeResult in /api/ucp/checkout/sessions (Lightning bolt11, Stripe clientSecret, fiat instructions, …). Null when not applicable. Each allOf branch discriminates on `method`; unknown methods fall through unvalidated.",
        type: ["object", "null"],
        properties: {
          method: {
            type: "string",
            enum: ["stripe", "lightning", "cashu", "fiat"],
          },
        },
        required: ["method"],
        allOf: [
          {
            if: {
              type: "object",
              properties: { method: { const: "lightning" } },
              required: ["method"],
            },
            then: {
              properties: {
                method: { const: "lightning" },
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
              },
              required: [
                "method",
                "bolt11",
                "quoteId",
                "amount",
                "currency",
                "verifyUrl",
              ],
              additionalProperties: false,
            },
          },
          {
            if: {
              type: "object",
              properties: { method: { const: "cashu" } },
              required: ["method"],
            },
            then: {
              properties: {
                method: { const: "cashu" },
                amount: { type: "number", description: "Redeemed token amount." },
                required: { type: "number", description: "Required amount." },
                change: { type: "number", description: "Change returned." },
                status: {
                  const: "paid",
                  description: "Cashu settles synchronously.",
                },
              },
              required: ["method", "amount", "required", "change", "status"],
              additionalProperties: false,
            },
          },
          {
            if: {
              type: "object",
              properties: { method: { const: "fiat" } },
              required: ["method"],
            },
            then: {
              properties: {
                method: { const: "fiat" },
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
              },
              required: [
                "method",
                "selectedMethod",
                "availableMethods",
                "amount",
                "currency",
                "sellerContact",
              ],
              additionalProperties: false,
            },
          },
          {
            if: {
              type: "object",
              properties: { method: { const: "stripe" } },
              required: ["method"],
            },
            then: {
              oneOf: [
                {
                  description: "One-time card payment (PaymentIntent).",
                  properties: {
                    method: { const: "stripe" },
                    type: { not: { const: "subscription" } },
                    amount: { type: "number" },
                    currency: { type: "string" },
                    paymentIntentId: { type: ["string", "null"] },
                    clientSecret: { type: ["string", "null"] },
                    connectedAccountId: { type: ["string", "null"] },
                  },
                  required: [
                    "method",
                    "amount",
                    "currency",
                    "paymentIntentId",
                    "clientSecret",
                    "connectedAccountId",
                  ],
                  additionalProperties: false,
                },
                {
                  description: "Recurring subscription checkout.",
                  properties: {
                    method: { const: "stripe" },
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
                  },
                  required: [
                    "method",
                    "type",
                    "subscriptionId",
                    "frequency",
                    "recurringAmount",
                    "currency",
                  ],
                  additionalProperties: false,
                },
              ],
            },
          },
        ],
        additionalProperties: true,
      },
      quote: {
        type: "object",
        description:
          "Pricing breakdown written by the order engine (pricingBlock in utils/ucp/order-service.ts). Omitted for subscriptions.",
        properties: {
          unitPrice: { type: "number" },
          quantity: { type: "number" },
          subtotal: { type: "number" },
          discountPercentage: {
            type: "number",
            description: "Present only when a discount applied.",
          },
          discountedSubtotal: {
            type: "number",
            description: "Present only when a discount applied.",
          },
          shippingCost: { type: "number" },
          total: { type: "number" },
          currency: { type: "string" },
          selectedSpecs: {
            type: "object",
            description: "Chosen product spec options, when any.",
          },
        },
        required: [
          "unitPrice",
          "quantity",
          "subtotal",
          "shippingCost",
          "total",
          "currency",
        ],
        additionalProperties: false,
      },
      messages: { type: "array", items: { $ref: "#/$defs/message" } },
      error: { type: "string" },
      code: {
        type: "string",
        description:
          "Machine-readable error code from the order engine (e.g. exchange_rate_unavailable), when the session carries an error.",
      },
      warning: {
        type: "string",
        description:
          "Non-fatal caveat (e.g. the session record could not be persisted but payment is still valid).",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      links: {
        type: "object",
        properties: {
          self: { type: "string", format: "uri" },
          discovery: { type: "string", format: "uri" },
        },
        required: ["self", "discovery"],
        additionalProperties: false,
      },
    },
    required: [
      "id",
      "status",
      "buyer",
      "seller",
      "productId",
      "paymentMethod",
      "messages",
      "createdAt",
      "updatedAt",
      "links",
    ],
    // Two escalation forms exist. A PRE-ORDER escalation (POST sessions
    // returned the envelope without placing an order — no orderId) has no
    // total or payment descriptor to report, so it must carry the explanatory
    // `error` instead. A PERSISTED session reconciled to requires_escalation
    // (its order's payment failed) keeps the order's amount/currency/payment.
    // Every non-escalation status carries amount/currency/payment too.
    allOf: [
      {
        if: {
          properties: { status: { const: "requires_escalation" } },
          required: ["status"],
        },
        then: {
          if: { not: { required: ["orderId"] } },
          then: { required: ["error"] },
          else: { required: ["amount", "currency", "payment"] },
        },
        else: { required: ["amount", "currency", "payment"] },
      },
    ],
    additionalProperties: true,
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).json(schema);
}
