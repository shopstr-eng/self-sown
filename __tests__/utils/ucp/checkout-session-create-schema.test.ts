/** @jest-environment node */

// Contract test: the request-side UCP checkout JSON Schema
// (pages/api/ucp/schemas/checkout-session-create.json.ts, linked from the
// discovery profile's checkout capability) must tell agent clients that
// quantity is a JSON number BEFORE they POST — POST /api/ucp/checkout/sessions
// rejects a string quantity with a 400 instead of silently ordering 1 item,
// and this schema is the only machine-readable place that rule is published.
// The quantity bounds must mirror the shared order-limits constants the order
// engine enforces, so the advertised contract and the enforced contract can't
// drift.

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "@/pages/api/ucp/schemas/checkout-session-create.json";
import { MAX_ORDER_QUANTITY } from "@/utils/ucp/order-limits";
import { SITE_HOST, SITE_URL } from "@/utils/site-url";

type JsonSchema = {
  $id?: string;
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

function getSchema(): JsonSchema {
  let body: JsonSchema | undefined;
  const res = {
    setHeader: () => res,
    status: () => res,
    json: (payload: JsonSchema) => {
      body = payload;
      return res;
    },
    end: () => res,
  } as unknown as NextApiResponse;
  handler(
    { method: "GET", headers: { host: SITE_HOST } } as NextApiRequest,
    res
  );
  if (!body) throw new Error("schema handler did not emit a body");
  return body;
}

describe("GET /api/ucp/schemas/checkout-session-create.json", () => {
  it("declares quantity as a bounded integer, not a string", () => {
    const quantity = getSchema().properties?.quantity;
    expect(quantity).toBeDefined();
    expect(quantity!.type).toBe("integer");
    expect(quantity!.minimum).toBe(1);
    expect(quantity!.maximum).toBe(MAX_ORDER_QUANTITY);
  });

  it("requires productId and documents the other accepted POST fields", () => {
    const schema = getSchema();
    expect(schema.required).toEqual(["productId"]);
    for (const field of [
      "quantity",
      "variantId",
      "buyerEmail",
      "shippingAddress",
      "selectedSize",
      "selectedVolume",
      "selectedWeight",
      "selectedBulkUnits",
      "discountCode",
      "paymentMethod",
      "mintUrl",
      "cashuToken",
      "fiatMethod",
      "subscriptionFrequency",
    ]) {
      expect(schema.properties?.[field]).toBeDefined();
    }
  });

  it("is addressable at the URL the discovery profile advertises", () => {
    expect(getSchema().$id).toBe(
      `${SITE_URL}/api/ucp/schemas/checkout-session-create.json`
    );
  });
});
