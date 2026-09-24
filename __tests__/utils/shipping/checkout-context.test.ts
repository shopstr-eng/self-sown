/** @jest-environment node */

// Unit coverage for the checkout-time shipping binding contract
// (utils/shipping/checkout-context.ts) shared by the payment-creation routes
// (which persist contexts) and the auto-label-purchase routes (which consume
// them). These pin the fail-closed rules: only sellers the payment actually
// charges may carry a context, and malformed/oversized input is dropped
// rather than coerced.

import {
  sanitizeCheckoutContext,
  sanitizeCheckoutContexts,
  sanitizeToAddress,
  stripeCheckoutRef,
  squareCheckoutRef,
} from "@/utils/shipping/checkout-context";

const SELLER = "a".repeat(64);
const OTHER = "b".repeat(64);

const VALID_ADDRESS = {
  name: "Buyer Person",
  street1: "100 Buyer St",
  city: "Buyerville",
  state: "CA",
  zip: "90001",
  country: "US",
};

function validContext(overrides: Record<string, unknown> = {}) {
  return {
    sellerPubkey: SELLER,
    orderId: "order-1",
    productId: "prod_evt_1",
    toAddress: VALID_ADDRESS,
    ...overrides,
  };
}

describe("payment ref builders", () => {
  it("namespaces refs by provider so ids can never collide", () => {
    expect(stripeCheckoutRef("pi_1")).toBe("stripe:pi_1");
    expect(squareCheckoutRef("pi_1")).toBe("square:pi_1");
    expect(stripeCheckoutRef("pi_1")).not.toBe(squareCheckoutRef("pi_1"));
  });
});

describe("sanitizeToAddress", () => {
  it("accepts a complete address and trims fields", () => {
    const addr = sanitizeToAddress({
      ...VALID_ADDRESS,
      street1: "  100 Buyer St  ",
    });
    expect(addr).toMatchObject({ street1: "100 Buyer St", zip: "90001" });
  });

  it.each(["street1", "city", "state", "zip", "country"])(
    "rejects when required field %s is missing",
    (field) => {
      const raw: Record<string, unknown> = { ...VALID_ADDRESS };
      delete raw[field];
      expect(sanitizeToAddress(raw)).toBeNull();
    }
  );

  it("rejects blank and over-long required fields instead of coercing them", () => {
    expect(sanitizeToAddress({ ...VALID_ADDRESS, city: "   " })).toBeNull();
    expect(
      sanitizeToAddress({ ...VALID_ADDRESS, street1: "x".repeat(301) })
    ).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(sanitizeToAddress(null)).toBeNull();
    expect(sanitizeToAddress("100 Buyer St")).toBeNull();
    expect(sanitizeToAddress(42)).toBeNull();
  });
});

describe("sanitizeCheckoutContext", () => {
  it("accepts a valid context for a seller the payment charges", () => {
    const ctx = sanitizeCheckoutContext(validContext(), new Set([SELLER]));
    expect(ctx).toMatchObject({
      sellerPubkey: SELLER,
      orderId: "order-1",
      productId: "prod_evt_1",
    });
  });

  it("drops a context for a seller the payment does NOT charge", () => {
    // Otherwise a buyer could plant a destination/product binding for a
    // seller who never sees this money.
    expect(
      sanitizeCheckoutContext(validContext(), new Set([OTHER]))
    ).toBeNull();
  });

  it("drops contexts with missing order/product/address", () => {
    expect(
      sanitizeCheckoutContext(validContext({ orderId: "" }), new Set([SELLER]))
    ).toBeNull();
    expect(
      sanitizeCheckoutContext(
        validContext({ productId: undefined }),
        new Set([SELLER])
      )
    ).toBeNull();
    expect(
      sanitizeCheckoutContext(
        validContext({ toAddress: { ...VALID_ADDRESS, zip: "" } }),
        new Set([SELLER])
      )
    ).toBeNull();
  });
});

describe("sanitizeCheckoutContexts", () => {
  it("keeps one context per allowed seller and drops the rest", () => {
    const contexts = sanitizeCheckoutContexts(
      [
        validContext(),
        validContext({ sellerPubkey: OTHER }),
        validContext({ sellerPubkey: "c".repeat(64) }), // not being charged
        validContext({ sellerPubkey: SELLER, orderId: "dup" }), // duplicate seller
      ],
      new Set([SELLER, OTHER])
    );
    expect(contexts).toHaveLength(2);
    expect(contexts.map((c) => c.sellerPubkey).sort()).toEqual([
      SELLER,
      OTHER,
    ]);
    // First valid entry for a seller wins.
    expect(contexts.find((c) => c.sellerPubkey === SELLER)?.orderId).toBe(
      "order-1"
    );
  });

  it("caps the number of contexts per payment", () => {
    const allowed = new Set<string>();
    const entries = Array.from({ length: 40 }, (_, i) => {
      const pk = `${String(i).padStart(2, "0")}${"d".repeat(62)}`;
      allowed.add(pk);
      return validContext({ sellerPubkey: pk });
    });
    expect(sanitizeCheckoutContexts(entries, allowed)).toHaveLength(25);
  });

  it("returns an empty list for non-array input", () => {
    expect(sanitizeCheckoutContexts(null, new Set([SELLER]))).toEqual([]);
    expect(
      sanitizeCheckoutContexts(validContext(), new Set([SELLER]))
    ).toEqual([]);
  });
});
