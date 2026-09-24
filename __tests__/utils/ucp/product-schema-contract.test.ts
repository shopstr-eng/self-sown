/** @jest-environment node */

// Contract test: the advertised UCP product JSON Schema
// (pages/api/ucp/schemas/product.json.ts, linked from the discovery profile)
// must accept what the canonical mapper (utils/ucp/catalog.ts) actually emits.
// The schema uses additionalProperties:false, so any new serialized field that
// isn't added to the schema breaks schema-validating agent consumers — this
// test fails when the two drift (caught for handlingTimeDays in task #109).

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "@/pages/api/ucp/schemas/product.json";
import openApiHandler from "@/pages/api/openapi.json";
import { SITE_HOST, SITE_URL } from "@/utils/site-url";
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
    { method: "GET", headers: { host: SITE_HOST } } as NextApiRequest,
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
  return eventToUcpProduct(event, { platformUrl: SITE_URL });
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

// The product shape is described TWICE: the canonical JSON Schema above and a
// condensed UcpProduct component in the published OpenAPI document
// (pages/api/openapi.json.ts). The condensed copy is allowed to be a subset
// (it is a summary), but its required list must not promise fields the
// canonical schema does not require, and it must not name properties the
// canonical schema does not declare — otherwise agents reading the OpenAPI
// doc learn a shape that never exists on the wire. Mirrors the parity block
// in __tests__/utils/ucp/checkout-session-schema-contract.test.ts.
describe("condensed OpenAPI UcpProduct ↔ canonical JSON Schema parity", () => {
  type OpenApiComponent = {
    required?: string[];
    properties?: Record<string, Record<string, any>>;
  };

  function loadCondensedComponent(): OpenApiComponent {
    let payload: Record<string, any> | undefined;
    const res = {
      setHeader: () => res,
      status: (code: number) => {
        expect(code).toBe(200);
        return res;
      },
      json: (body: Record<string, any>) => {
        payload = body;
        return res;
      },
    } as unknown as NextApiResponse;
    openApiHandler({} as NextApiRequest, res);
    const component = payload?.components?.schemas?.UcpProduct;
    if (!component) {
      throw new Error("openapi.json is missing the UcpProduct component");
    }
    return component;
  }

  const schema = getSchema() as Record<string, any>;
  const condensed = loadCondensedComponent();

  it("exercises real fields on both copies (non-vacuous)", () => {
    expect(condensed.required!.length).toBeGreaterThan(0);
    expect(schema.required.length).toBeGreaterThan(condensed.required!.length);
    expect(Object.keys(condensed.properties!).length).toBeGreaterThan(5);
    expect(Object.keys(schema.properties).length).toBeGreaterThan(
      Object.keys(condensed.properties!).length
    );
  });

  it("keeps the condensed required list a subset of the canonical required list", () => {
    // A condensed-required field the canonical schema does not require would
    // tell agents a field is always present when it is not.
    for (const field of condensed.required!) {
      expect(schema.required).toContain(field);
    }
  });

  it("declares every condensed property in the canonical schema (rename/add drift)", () => {
    // Catches either copy renaming or adding a field without the other: a
    // renamed canonical field leaves the condensed name dangling, and a
    // condensed-only field is a plain invention. Canonical-only additions
    // (e.g. inventory, variants, ext) are allowed — the view is deliberately
    // condensed.
    for (const name of Object.keys(condensed.properties!)) {
      expect(schema.properties).toHaveProperty(name);
    }
  });

  it("keeps the type enum identical across both copies", () => {
    // The canonical schema pins type with `const`; the condensed copy uses a
    // one-value `enum` — normalize before comparing.
    const canonical = schema.properties.type.enum ?? [schema.properties.type.const];
    const condensedType = condensed.properties?.type;
    expect(condensedType).toBeDefined();
    expect(condensedType?.enum).toEqual(canonical);
  });

  it("keeps the availability enum identical across both copies", () => {
    const condensedAvailability = condensed.properties?.availability;
    expect(condensedAvailability).toBeDefined();
    expect(condensedAvailability?.enum).toEqual(
      schema.properties.availability.enum
    );
  });
});
