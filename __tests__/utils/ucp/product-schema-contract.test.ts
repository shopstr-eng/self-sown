/** @jest-environment node */

// Contract test: the advertised UCP product JSON Schema
// (pages/api/ucp/schemas/product.json.ts, linked from the discovery profile)
// must accept what the canonical mapper (utils/ucp/catalog.ts) actually emits.
// The schema uses additionalProperties:false, so any new serialized field that
// isn't added to the schema breaks schema-validating agent consumers — this
// test fails when the two drift (caught for handlingTimeDays in task #109).

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "@/pages/api/ucp/schemas/product.json";
import { eventToUcpProduct } from "@/utils/ucp/catalog";
import type { NostrEvent } from "@/utils/types/types";

type JsonSchema = {
  $defs?: Record<
    string,
    {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
      additionalProperties?: boolean;
    }
  >;
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
    { method: "GET", headers: { host: "milk.market" } } as NextApiRequest,
    res
  );
  if (!body) throw new Error("schema handler did not emit a body");
  return body;
}

// A product exercising EVERY optional shipping field the mapper can emit.
function makeFullyLoadedProduct() {
  const event = {
    id: "evt-1",
    pubkey: "00".repeat(32),
    created_at: 1_700_000_000,
    kind: 30402,
    content: "",
    sig: "sig",
    tags: [
      ["d", "raw-milk-gallon"],
      ["title", "Raw Milk"],
      ["price", "12", "USD"],
      ["shipping", "Added Cost", "5", "USD"],
      ["pickup_location", "Farm gate"],
      ["handling_time", "2"],
    ],
  } as NostrEvent;
  return eventToUcpProduct(event, { platformUrl: "https://milk.market" });
}

describe("UCP product JSON Schema ↔ catalog mapper contract", () => {
  it("declares every shipping field the mapper emits", () => {
    const schema = getSchema();
    const shippingDef = schema.$defs?.shipping;
    expect(shippingDef).toBeDefined();
    expect(shippingDef!.additionalProperties).toBe(false);

    const product = makeFullyLoadedProduct();
    // Sanity: the fixture really does populate the optional fields, so the
    // allowlist check below can't pass vacuously.
    expect(product.shipping.destinationCountries).toEqual(["US"]);
    expect(product.shipping.handlingTimeDays).toBe(2);
    expect(product.shipping.pickupLocations).toEqual(["Farm gate"]);

    for (const key of Object.keys(product.shipping)) {
      expect(shippingDef!.properties).toHaveProperty(key);
    }
    for (const required of shippingDef!.required ?? []) {
      expect(product.shipping).toHaveProperty(required);
    }
  });

  it("constrains handlingTimeDays and destinationCountries correctly", () => {
    const schema = getSchema();
    const props = schema.$defs?.shipping?.properties ?? {};
    expect(props.handlingTimeDays).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(props.destinationCountries).toMatchObject({ type: "array" });
    expect(
      (props.destinationCountries as { items?: Record<string, unknown> })?.items
    ).toMatchObject({ type: "string", pattern: "^[A-Z]{2}$" });
  });
});
