import type { NextApiRequest, NextApiResponse } from "next";
import { deriveBaseUrl } from "@/utils/ucp/seller-host";

/**
 * GET /api/ucp/schemas/product.json — JSON Schema (draft 2020-12) for the UCP
 * product shape returned by the catalog endpoints. The UCP discovery profile
 * points its catalog capability `schema` at this URL so shopping agents can
 * validate / introspect the response. It mirrors `UcpProduct` in
 * utils/ucp/types.ts (kept in sync by hand — both are small and stable).
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

  const money = {
    type: "object",
    description:
      "An amount in a currency's minor units, with display metadata.",
    properties: {
      currency: {
        type: "string",
        description: 'ISO 4217 code, or "XBT" for bitcoin-denominated prices.',
      },
      amount: {
        type: "integer",
        description:
          "Integer amount in the currency's minor units (cents, sats, or whole units for zero-decimal currencies).",
      },
      exponent: {
        type: "integer",
        description: "Minor units per major unit are 10^exponent.",
      },
      display: {
        type: "string",
        description:
          'Human-readable formatted amount, e.g. "12.00" or "1500 sat".',
      },
    },
    required: ["currency", "amount", "exponent", "display"],
    additionalProperties: false,
  };

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/api/ucp/schemas/product.json`,
    title: "UCP Product",
    description:
      "Universal Commerce Protocol representation of a Milk Market listing (NIP-99 kind:30402).",
    type: "object",
    $defs: {
      money,
      taxonomy: {
        type: "object",
        description: "Standard product taxonomy full-path strings.",
        properties: {
          google: {
            type: "string",
            description: "Google Product Category full path.",
          },
          shopify: {
            type: "string",
            description: "Shopify Standard Product Taxonomy full path.",
          },
        },
        additionalProperties: false,
      },
      seller: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "Nostr pubkey (hex) — stable seller identifier.",
          },
          npub: { type: "string", description: "Bech32 npub of the pubkey." },
          name: { type: "string" },
          url: { type: "string", format: "uri" },
        },
        required: ["pubkey", "npub"],
        additionalProperties: false,
      },
      shipping: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Milk Market shipping option (Pickup, Free, Added Cost, …).",
          },
          cost: {
            description: "Shipping cost, or null when not quotable up front.",
            oneOf: [{ $ref: "#/$defs/money" }, { type: "null" }],
          },
          pickupAvailable: { type: "boolean" },
          pickupLocations: { type: "array", items: { type: "string" } },
        },
        required: ["type", "cost", "pickupAvailable"],
        additionalProperties: false,
      },
      variant: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: 'Stable variant key, e.g. "size:1 Gallon".',
          },
          title: { type: "string" },
          attributes: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          price: { $ref: "#/$defs/money" },
          available: { type: "boolean" },
        },
        required: ["id", "title", "attributes", "price", "available"],
        additionalProperties: false,
      },
      subscription: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          discountPercent: { type: "number" },
          frequencies: { type: "array", items: { type: "string" } },
        },
        required: ["enabled", "frequencies"],
        additionalProperties: false,
      },
    },
    properties: {
      id: { type: "string", description: "Nostr event id." },
      type: { const: "product" },
      title: { type: "string" },
      description: { type: "string" },
      url: {
        type: "string",
        format: "uri",
        description:
          "Absolute canonical product URL (host-scoped on seller domains).",
      },
      images: { type: "array", items: { type: "string", format: "uri" } },
      price: { $ref: "#/$defs/money" },
      categories: { type: "array", items: { type: "string" } },
      taxonomy: { $ref: "#/$defs/taxonomy" },
      availability: {
        type: "string",
        enum: ["in_stock", "out_of_stock", "preorder", "unknown"],
      },
      inventory: {
        type: "object",
        properties: {
          tracked: { type: "boolean" },
          quantity: { type: ["integer", "null"] },
        },
        required: ["tracked", "quantity"],
        additionalProperties: false,
      },
      seller: { $ref: "#/$defs/seller" },
      location: { type: "string" },
      shipping: { $ref: "#/$defs/shipping" },
      paymentMethods: {
        type: "array",
        items: { type: "string" },
        description:
          "Accepted payment methods (always lightning + cashu; stripe when enabled).",
      },
      variants: { type: "array", items: { $ref: "#/$defs/variant" } },
      subscription: { $ref: "#/$defs/subscription" },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "RFC3339 last-updated timestamp (Nostr event created_at).",
      },
      ext: {
        type: "object",
        description:
          'Vendor extension block keyed under the reverse-DNS namespace "market.milk".',
      },
    },
    required: [
      "id",
      "type",
      "title",
      "description",
      "url",
      "images",
      "price",
      "categories",
      "availability",
      "seller",
      "shipping",
      "paymentMethods",
      "updatedAt",
      "ext",
    ],
    additionalProperties: true,
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).json(schema);
}
