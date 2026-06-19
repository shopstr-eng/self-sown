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
      "A checkout session wrapping a Milk Market order. Its status is reconciled against the canonical order payment status; there is no parallel order state machine.",
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
          "Underlying Milk Market order id, when an order was created.",
      },
      paymentMethod: {
        type: "string",
        enum: ["stripe", "lightning", "cashu", "fiat"],
      },
      amount: { type: "number", description: "Order total in major units." },
      currency: { type: "string" },
      payment: {
        description:
          "Method-specific payment descriptor (e.g. Lightning bolt11, Stripe clientSecret, fiat instructions). Null when not applicable.",
        type: ["object", "null"],
        properties: { method: { type: "string" } },
        required: ["method"],
        additionalProperties: true,
      },
      quote: {
        type: "object",
        description: "Pricing breakdown for the order, when available.",
        additionalProperties: true,
      },
      messages: { type: "array", items: { $ref: "#/$defs/message" } },
      error: { type: "string" },
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
      "amount",
      "currency",
      "payment",
      "messages",
      "createdAt",
      "updatedAt",
      "links",
    ],
    additionalProperties: true,
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).json(schema);
}
