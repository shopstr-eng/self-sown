import type { NextApiRequest, NextApiResponse } from "next";
import { MAX_ORDER_QUANTITY } from "@/utils/ucp/order-limits";
import { deriveBaseUrl } from "@/utils/ucp/seller-host";

/**
 * GET /api/ucp/schemas/checkout-session-create.json — JSON Schema (draft
 * 2020-12) for the REQUEST body accepted by POST /api/ucp/checkout/sessions.
 * The sibling checkout-session.json documents only the RESPONSE session
 * object, so without this document an agent client had no machine-readable
 * way to learn that quantity must be a JSON number (integer, 1..
 * MAX_ORDER_QUANTITY) until it hit the 400. The UCP discovery profile links
 * this URL alongside the response schema. It mirrors the fields read by
 * `handleCreate` in pages/api/ucp/checkout/sessions.ts and enforced by
 * `createOrderFlow` in utils/ucp/order-service.ts.
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
    $id: `${base}/api/ucp/schemas/checkout-session-create.json`,
    title: "UCP Checkout Session Create Request",
    description:
      "Request body for POST /api/ucp/checkout/sessions. Only an omitted quantity means \"one\"; a non-number quantity (e.g. the string \"5\") is rejected with HTTP 400 rather than coerced.",
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product id from the catalog.",
      },
      quantity: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ORDER_QUANTITY,
        default: 1,
        description:
          "JSON number, NOT a string. A string like \"5\" is rejected with HTTP 400. Omit to order one.",
      },
      variantId: {
        type: "string",
        description:
          'Catalog variant id (e.g. "size:1 Gallon"); decoded into the order-engine selection. An explicit selected* field still wins.',
      },
      buyerEmail: {
        type: "string",
        format: "email",
        description: "Buyer contact for order updates.",
      },
      shippingAddress: {
        type: "object",
        description: "Delivery address for shipped orders.",
        additionalProperties: true,
      },
      selectedSize: { type: "string" },
      selectedVolume: { type: "string" },
      selectedWeight: { type: "string" },
      selectedBulkUnits: {
        type: "integer",
        description:
          "Bulk/bundle tier size in units, when the product offers bulk pricing. Multiplies quantity into the effective quantity.",
      },
      discountCode: { type: "string" },
      paymentMethod: {
        type: "string",
        enum: ["stripe", "lightning", "cashu", "fiat"],
        default: "stripe",
      },
      mintUrl: {
        type: "string",
        format: "uri",
        description: "Cashu mint URL (cashu payments).",
      },
      cashuToken: {
        type: "string",
        description: "Pre-built Cashu token (cashu payments).",
      },
      fiatMethod: {
        type: "string",
        description: "Manual fiat rail label (fiat payments).",
      },
      subscriptionFrequency: {
        type: "string",
        description:
          "Recurring cadence (e.g. weekly/monthly), only for subscription-enabled products.",
      },
    },
    required: ["productId"],
    additionalProperties: true,
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).json(schema);
}
