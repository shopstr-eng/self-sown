/** @jest-environment node */

// Pins that the Lightning expiry the order engine advertises comes from the
// REAL invoice/quote, not a hardcoded offset.
//
// WHY THIS EXISTS
// pages/api/mcp/create-order.ts used to tell agents the invoice expired at
// `Date.now() + 10 * 60 * 1000` while the mint's actual BOLT-11 default is 1
// hour (and the mint quote carries its own `expiry`). Agents could abandon a
// payable invoice early or retry an expired one. resolveLightningInvoiceExpiry
// now derives expiresAt from the mint quote's `expiry`, falling back to the
// bolt11 `timestamp + expiry` tag (BOLT-11 default 3600s), and fails closed if
// neither is determinable.

jest.mock("@/utils/db/db-service", () => ({
  fetchAllProductsFromDb: jest.fn(async () => [productEvent]),
  fetchAllProfilesFromDb: jest.fn(async () => []),
  getStripeConnectAccount: jest.fn(async () => null),
  validateDiscountCode: jest.fn(async () => ({ valid: false })),
  markDiscountCodeUsed: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(async () => ({ tracked: false })),
  deductStock: jest.fn(),
}));
jest.mock("@/mcp/tools/purchase-tools", () => ({
  createMcpOrder: jest.fn(async (orderId: string) => ({
    id: orderId,
    order_id: orderId,
  })),
  updateMcpOrderPayment: jest.fn(),
  // Lightning quotes persist to Postgres now; keep the suite off the DB.
  savePendingLightningQuote: jest.fn(async () => {}),
}));

const mockCreateMintQuoteBolt11 = jest.fn();
jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn().mockImplementation(() => ({
    loadMint: jest.fn(async () => {}),
    createMintQuoteBolt11: (...args: any[]) =>
      mockCreateMintQuoteBolt11(...args),
  })),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

import {
  createOrderFlow,
  resolveLightningInvoiceExpiry,
} from "@/utils/ucp/order-service";

const SELLER_PUBKEY = "cd".repeat(32);

const productEvent = {
  id: "prod-evt-id",
  pubkey: SELLER_PUBKEY,
  kind: 30402,
  created_at: 1700000000,
  content: "",
  sig: "",
  tags: [
    ["d", "dtag-1"],
    ["title", "Test Item"],
    ["price", "100", "sats"],
    ["quantity", "5"],
  ],
};

const lightningInput = () => ({
  productId: "prod-evt-id",
  quantity: 1,
  paymentMethod: "lightning" as const,
  apiKeyId: 1,
  buyerPubkey: "ab".repeat(32),
});

// Real bolt11 fixtures (signed test invoices: amount 1500 sats, timestamp
// 1700000000). WITH_EXPIRY carries an expiry tag of 7200s; NO_EXPIRY carries
// none, exercising the BOLT-11 default of 3600s.
const REAL_INVOICE =
  "lnbc15u1pj48ugqpp54w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4ssp5ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxsdq5w3jhxapqd9h8vmmfvdjsxqr8pqmfpmr4y4z8tslgjr0pcuh97d4l22f88k0rlmsgscf0dwgh9zt4vrlw4rdlcxkn34la6xe2j385tp2wg8x7ya2lwzd4ecgs9z3tj6ptqq6sq5m5";
const REAL_INVOICE_EXPIRES_AT = "2023-11-15T00:13:20.000Z"; // ts + 7200s
const REAL_INVOICE_NO_EXPIRY =
  "lnbc15u1pj48ugqpp54w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4ssp5ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxsdq5w3jhxapqd9h8vmmfvdjsz5l5qwkc2e06gy6j3jk7xtvygf03ycrm6k7mcxhj74zpavsh2zqpazakfws43y8uqa5t4ht4cnqsx0q6m49gyz5egztzgkl0c58egpqq6mjf28";
const REAL_INVOICE_NO_EXPIRY_EXPIRES_AT = "2023-11-14T23:13:20.000Z"; // ts + 3600s

// Real regtest-style invoice shape is irrelevant to the quote-expiry path;
// the quote `expiry` wins and the invoice is never decoded.
const PLACEHOLDER_INVOICE = "lnbcrt1placeholder";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveLightningInvoiceExpiry", () => {
  it("prefers the mint quote's expiry (unix seconds) over decoding", () => {
    const expiry = 1_900_000_000;
    expect(
      resolveLightningInvoiceExpiry({
        request: "lnbc1undecodable",
        expiry,
      })
    ).toBe(new Date(expiry * 1000).toISOString());
  });

  it("falls back to the bolt11 timestamp + expiry tag", () => {
    const decoded = resolveLightningInvoiceExpiry({
      request: REAL_INVOICE,
      expiry: null,
    });
    expect(decoded).toBe(REAL_INVOICE_EXPIRES_AT);
  });

  it("applies the BOLT-11 default 1-hour expiry when the tag is absent", () => {
    // REAL_INVOICE_NO_EXPIRY carries no expiry tag; expiry must be
    // timestamp + 3600s per the BOLT-11 spec default.
    const decoded = resolveLightningInvoiceExpiry({
      request: REAL_INVOICE_NO_EXPIRY,
      expiry: null,
    });
    expect(decoded).toBe(REAL_INVOICE_NO_EXPIRY_EXPIRES_AT);
  });

  it("fails closed when neither the quote nor the invoice yields an expiry", () => {
    // OrderServiceError.message is body.error; the reason lives in body.details.
    let thrown: any;
    try {
      resolveLightningInvoiceExpiry({ request: "not-an-invoice", expiry: null });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(500);
    expect(thrown.body.details).toMatch(/no determinable expiry/i);
  });
});

describe("createOrderFlow lightning arm", () => {
  it("advertises the mint quote's real expiry, not a fixed offset", async () => {
    const expiry = 1_900_000_000; // far future: provably not "now + 10 min"
    mockCreateMintQuoteBolt11.mockResolvedValue({
      quote: "quote_1",
      request: PLACEHOLDER_INVOICE,
      expiry,
    });

    const result = await createOrderFlow(lightningInput());
    if (result.kind !== "lightning") throw new Error("expected lightning");
    expect(result.expiresAt).toBe(new Date(expiry * 1000).toISOString());
  });
});
