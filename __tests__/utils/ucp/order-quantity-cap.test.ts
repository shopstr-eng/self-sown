/** @jest-environment node */

// Coverage for the server-side order-quantity cap in createOrderFlow
// (utils/ucp/order-service.ts).
//
// WHY THIS EXISTS
// The MCP `create_order` zod schema caps quantity at MAX_ORDER_QUANTITY, but
// that bound lives only in the schema: a direct REST caller of
// /api/mcp/create-order (or any route funnelling into createOrderFlow) could
// pass quantity=1000000000, which multiplies straight into subtotal/invoice
// amounts and stock checks. The cap must therefore be enforced inside the
// order service itself so removing the MCP schema bound can't reopen the hole.

jest.mock("@/utils/db/db-service", () => ({
  fetchAllProductsFromDb: jest.fn(async () => []),
  fetchAllProfilesFromDb: jest.fn(async () => []),
  getStripeConnectAccount: jest.fn(async () => null),
  validateDiscountCode: jest.fn(async () => ({ valid: false })),
  markDiscountCodeUsed: jest.fn(),
  getDbPool: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(async () => ({ tracked: false })),
  deductStock: jest.fn(),
}));
jest.mock("@/mcp/tools/purchase-tools", () => ({
  createMcpOrder: jest.fn(),
  updateMcpOrderPayment: jest.fn(),
}));

import {
  createOrderFlow,
  OrderServiceError,
  MAX_ORDER_QUANTITY,
} from "@/utils/ucp/order-service";

const orderInput = (quantity: number) => ({
  productId: "prod-evt-id",
  quantity,
  paymentMethod: "lightning" as const,
  apiKeyId: 1,
  buyerPubkey: "ab".repeat(32),
});

const expectRejection = async (
  quantity: number
): Promise<OrderServiceError> =>
  createOrderFlow(orderInput(quantity)).then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e
  );

describe("createOrderFlow quantity cap", () => {
  it("rejects an absurd quantity with a 400 before any product lookup", async () => {
    const err = await expectRejection(1_000_000_000);
    expect(err).toBeInstanceOf(OrderServiceError);
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(
      new RegExp(`quantity must not exceed ${MAX_ORDER_QUANTITY}`)
    );
  });

  it("rejects quantity just above the cap", async () => {
    const err = await expectRejection(MAX_ORDER_QUANTITY + 1);
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(/must not exceed/);
  });

  it("keeps the cap aligned with the MCP schema bound of 10000", () => {
    // The MCP create_order schema (pages/api/mcp/index.ts) uses .max(10000);
    // if either bound changes, this test forces a deliberate decision instead
    // of silent drift between the schema and the service-level guard.
    expect(MAX_ORDER_QUANTITY).toBe(10000);
  });

  it("still rejects non-positive and non-integer quantities", async () => {
    for (const bad of [0, -5, 1.5]) {
      const err = await expectRejection(bad);
      expect(err.status).toBe(400);
      expect(err.body.error).toMatch(/positive integer/);
    }
  });
});
