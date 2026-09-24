/** @jest-environment node */

import { createHash } from "node:crypto";

import {
  buildMcpRequestProofTags,
  buildMcpRequestProofTemplate,
  buildShippingDefaultsProof,
  buildShippingRatesProof,
  matchesMcpRequestProof,
} from "../request-proof";

const PUBKEY = "a".repeat(64);

function eventFor(proof: ReturnType<typeof buildShippingDefaultsProof>) {
  return {
    ...buildMcpRequestProofTemplate(proof),
    id: "b".repeat(64),
    pubkey: PUBKEY,
    sig: "c".repeat(128),
  };
}

test("shipping-default write proofs are bound to every mutable field", () => {
  const original = buildShippingDefaultsProof({
    pubkey: PUBKEY,
    method: "POST",
    defaults: {
      fromStreet1: "1 Farm Road",
      fromZip: "78701",
      preferredCarriers: ["USPS", "UPS"],
      autoPurchaseLabels: true,
    },
  });
  const event = eventFor(original);

  expect(matchesMcpRequestProof(event, original)).toBe(true);
  expect(
    matchesMcpRequestProof(
      event,
      buildShippingDefaultsProof({
        pubkey: PUBKEY,
        method: "POST",
        defaults: {
          fromStreet1: "99 Attacker Avenue",
          fromZip: "78701",
          preferredCarriers: ["USPS", "UPS"],
          autoPurchaseLabels: true,
        },
      })
    )
  ).toBe(false);
});

test("carrier arrays cannot collide with comma-containing values", () => {
  const original = buildShippingDefaultsProof({
    pubkey: PUBKEY,
    method: "POST",
    defaults: { preferredCarriers: ["USPS", "UPS"] },
  });
  const event = eventFor(original);

  expect(
    matchesMcpRequestProof(
      event,
      buildShippingDefaultsProof({
        pubkey: PUBKEY,
        method: "POST",
        defaults: { preferredCarriers: ["USPS,UPS"] },
      })
    )
  ).toBe(false);
});

test("seller rate proofs bind the order and every quote input", () => {
  const original = buildShippingRatesProof({
    pubkey: PUBKEY,
    orderId: "order-1",
    from: {
      street1: "1 Farm Road",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
    },
    to: {
      street1: "2 Buyer Street",
      city: "Denver",
      state: "CO",
      zip: "80202",
      country: "US",
    },
    parcel: { weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
    carriers: ["USPS", "UPS"],
  });
  const event = eventFor(original);

  expect(matchesMcpRequestProof(event, original)).toBe(true);
  expect(
    matchesMcpRequestProof(
      event,
      buildShippingRatesProof({
        pubkey: PUBKEY,
        orderId: "someone-elses-order",
        from: {
          street1: "1 Farm Road",
          city: "Austin",
          state: "TX",
          zip: "78701",
          country: "US",
        },
        to: {
          street1: "99 Attacker Avenue",
          city: "Denver",
          state: "CO",
          zip: "80202",
          country: "US",
        },
        parcel: { weightOz: 160, lengthIn: 8, widthIn: 6, heightIn: 4 },
        carriers: ["FEDEX"],
      })
    )
  ).toBe(false);
});

test("seller rate proofs bind a canonical body hash without exposing shipping PII", () => {
  const proof = buildShippingRatesProof({
    pubkey: PUBKEY,
    orderId: "order-private",
    from: {
      name: "Seller Name",
      street1: "1 Private Farm Road",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
      phone: "+15125550100",
      email: "seller@example.com",
    },
    to: {
      name: "Buyer Name",
      street1: "2 Private Buyer Street",
      city: "Denver",
      state: "CO",
      zip: "80202",
      country: "US",
      phone: "+13035550100",
      email: "buyer@example.com",
    },
    parcel: { weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
    carriers: ["USPS", "UPS"],
  });
  const canonicalBody = JSON.stringify({
    carriers: ["USPS", "UPS"],
    from: {
      city: "Austin",
      country: "US",
      email: "seller@example.com",
      name: "Seller Name",
      phone: "+15125550100",
      state: "TX",
      street1: "1 Private Farm Road",
      zip: "78701",
    },
    orderId: "order-private",
    parcel: { heightIn: 4, lengthIn: 8, weightOz: 16, widthIn: 6 },
    to: {
      city: "Denver",
      country: "US",
      email: "buyer@example.com",
      name: "Buyer Name",
      phone: "+13035550100",
      state: "CO",
      street1: "2 Private Buyer Street",
      zip: "80202",
    },
  });
  const expectedHash = createHash("sha256").update(canonicalBody).digest("hex");

  expect(proof.fields).toEqual({ bodySha256: expectedHash });
  expect(JSON.stringify(buildMcpRequestProofTags(proof))).not.toMatch(
    /Private|Seller Name|Buyer Name|\+1512|\+1303|example\.com/
  );
});
