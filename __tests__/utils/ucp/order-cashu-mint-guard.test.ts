/** @jest-environment node */

// Coverage for the Cashu mint trust boundary in the UCP/MCP order engine
// (utils/ucp/order-service.ts initializeCashu).
//
// WHY THIS EXISTS
// cashu-ts v4 can't decode v2-keyset tokens without the mint's keyset list, so
// decoding fetches the token-embedded mint's /v1/keysets. That fetch MUST NOT
// happen before the mint is validated against ALLOWED_MINT_URLS: a crafted
// token would otherwise turn order creation into SSRF (or point the server at
// a fake mint that always reports redemption success). The guard parses the
// token envelope (no network) and rejects untrusted mints BEFORE decoding.

import { getEncodedToken, type Proof } from "@cashu/cashu-ts";

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
  createMcpOrder: jest.fn(),
  updateMcpOrderPayment: jest.fn(),
}));
// The allowlisted-mint case exercises the SSRF-guarded keyset fetch; bypass
// the guard here (the fetch spy below is the assertion surface).
jest.mock("@/utils/url-safety", () => ({
  ...jest.requireActual("@/utils/url-safety"),
  safeFetch: (url: string) => fetch(url),
}));

import {
  createOrderFlow,
  OrderServiceError,
  DEFAULT_MINT_URL,
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

const V2_KEYSET_ID = "01" + "ab".repeat(31);

const v2Token = (mint: string, amount = 100): string =>
  getEncodedToken({
    mint,
    unit: "sat",
    proofs: [
      {
        id: V2_KEYSET_ID,
        amount,
        secret: "s".repeat(64),
        C: "02" + "cd".repeat(32),
      } as unknown as Proof,
    ],
  });

const orderInput = (cashuToken: string) => ({
  productId: "prod-evt-id",
  quantity: 1,
  paymentMethod: "cashu" as const,
  cashuToken,
  apiKeyId: 1,
  buyerPubkey: "ab".repeat(32),
});

const realFetch = globalThis.fetch;
let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keysets: [{ id: V2_KEYSET_ID }] }),
  });
  (globalThis as any).fetch = fetchSpy;
});
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

describe("createOrderFlow Cashu mint trust boundary", () => {
  it("rejects a token from an untrusted mint WITHOUT any network fetch", async () => {
    // v2 keyset id: plain decode WOULD need the mint's keyset list, so any
    // fetch here proves the guard ran after decode (SSRF) instead of before.
    const token = v2Token("http://169.254.169.254");

    const err: OrderServiceError = await createOrderFlow(
      orderInput(token)
    ).then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e
    );
    expect(err).toBeInstanceOf(OrderServiceError);
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(/not a supported mint/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unparseable token envelope WITHOUT any network fetch", async () => {
    const err: OrderServiceError = await createOrderFlow(
      orderInput("cashuB_garbage")
    ).then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e
    );
    expect(err).toBeInstanceOf(OrderServiceError);
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(/could not parse the token envelope/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches keysets only for an allowlisted mint", async () => {
    // The token decodes; redemption then fails against the stubbed mint —
    // irrelevant here. What matters is the ORDERING: the keyset fetch is
    // permitted only after the allowlist check passes.
    const token = v2Token(DEFAULT_MINT_URL);
    await createOrderFlow(orderInput(token)).catch(() => {});
    expect(fetchSpy).toHaveBeenCalledWith(`${DEFAULT_MINT_URL}/v1/keysets`);
  });

  it("reports a numeric (uncorrupted) token amount on insufficient funds", async () => {
    // cashu-ts v4 decodes proof amounts as Amount instances; a naive
    // `sum + (p.amount || 0)` concatenates them into a string like "050".
    const token = v2Token(DEFAULT_MINT_URL, 50); // below the 100-sat price
    const err: OrderServiceError = await createOrderFlow(
      orderInput(token)
    ).then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e
    );
    expect(err).toBeInstanceOf(OrderServiceError);
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(/Insufficient/i);
    expect(err.body.provided).toBe(50); // a number, not the string "050"
  });
});
