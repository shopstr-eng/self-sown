/** @jest-environment node */

// Route-level coverage for the buyer/guest-facing Square card charge in
// pages/api/square/create-payment.ts. These are the exact paths where a
// regression would silently confirm an UNPAID or WRONG-CURRENCY order, so each
// is pinned here:
//
//   1. Only Square's COMPLETED status confirms an order. autocomplete:true is
//      always requested, so APPROVED (funds only authorized, never captured) —
//      and any other non-COMPLETED status — must return 402 and NOT report
//      success, never confirming an order against uncaptured funds.
//   2. The currency guard rejects a cart currency that differs from the seller's
//      Square location settlement currency, and rejects sats/BTC unless the
//      location settles USD.
//   3. The seller's Square connection (token + location) is resolved
//      server-side from the pubkey; any client-supplied token/location in the
//      body is ignored — only the resolved access drives the charge.
//   4. When Square isn't configured for the deployment the route fails closed
//      with 503 before touching any seller connection.
//
// Heavy deps (square-api, rate-limit, currency FX) are mocked so a future
// refactor can't silently mis-charge or mis-confirm a buyer.

const applyRateLimitMock = jest.fn();
const getValidSquareAccessTokenMock = jest.fn();
const createSquarePaymentMock = jest.fn();
const isSquareConfiguredMock = jest.fn();
const satsToUSDMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/square/square-api", () => ({
  getValidSquareAccessToken: (...args: unknown[]) =>
    getValidSquareAccessTokenMock(...args),
  createSquarePayment: (...args: unknown[]) => createSquarePaymentMock(...args),
}));

jest.mock("@/utils/square/square-config", () => ({
  isSquareConfigured: (...args: unknown[]) => isSquareConfiguredMock(...args),
}));

// Keep isCrypto/toSmallestUnit/isExchangeRateError real (they drive the
// currency-guard branch selection and error mapping) but mock only the
// network-bound FX call.
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return {
    __esModule: true,
    ...actual,
    satsToUSD: (...args: unknown[]) => satsToUSDMock(...args),
  };
});

import createSquarePaymentHandler from "@/pages/api/square/create-payment";

const SELLER = "a".repeat(64);

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function usdAccess(over: Record<string, unknown> = {}) {
  return {
    accessToken: "server_resolved_token",
    locationId: "L_SERVER",
    locationCurrency: "USD",
    merchantId: "M1",
    ...over,
  };
}

async function callHandler(body: Record<string, unknown>) {
  const res = makeRes();
  await createSquarePaymentHandler({ method: "POST", body } as any, res as any);
  return res;
}

beforeEach(() => {
  applyRateLimitMock.mockReset().mockResolvedValue(true);
  isSquareConfiguredMock.mockReset().mockReturnValue(true);
  getValidSquareAccessTokenMock.mockReset().mockResolvedValue(usdAccess());
  createSquarePaymentMock
    .mockReset()
    .mockResolvedValue({ id: "sqpay_1", status: "COMPLETED" });
  satsToUSDMock.mockReset();
});

describe("POST /api/square/create-payment — only COMPLETED confirms an order", () => {
  it("returns 200 success when Square settles the charge as COMPLETED", async () => {
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      paymentId: "sqpay_1",
      status: "COMPLETED",
    });
  });

  it("returns 402 (NOT success) when the charge is only APPROVED (uncaptured)", async () => {
    createSquarePaymentMock.mockResolvedValue({
      id: "sqpay_appr",
      status: "APPROVED",
    });
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(402);
    expect((res.body as any).success).toBeUndefined();
    expect((res.body as any).error).toMatch(/not completed/i);
    expect((res.body as any).status).toBe("APPROVED");
  });

  it.each(["PENDING", "CANCELED", "FAILED", ""])(
    "returns 402 (NOT success) for non-COMPLETED status %p",
    async (status) => {
      createSquarePaymentMock.mockResolvedValue({ id: "sqpay_x", status });
      const res = await callHandler({
        sourceId: "cnon_card",
        amount: 10,
        currency: "USD",
        sellerPubkey: SELLER,
      });
      expect(res.statusCode).toBe(402);
      expect((res.body as any).success).toBeUndefined();
    }
  );
});

describe("POST /api/square/create-payment — currency guard", () => {
  it("rejects a cart currency that differs from the location settlement currency", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "USD" })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "EUR",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("currency_mismatch");
    expect(createSquarePaymentMock).not.toHaveBeenCalled();
  });

  it("rejects sats when the location does NOT settle USD", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "EUR" })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 1000,
      currency: "sats",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("currency_mismatch");
    expect(satsToUSDMock).not.toHaveBeenCalled();
    expect(createSquarePaymentMock).not.toHaveBeenCalled();
  });

  it("accepts sats when the location settles USD, converting to USD cents", async () => {
    satsToUSDMock.mockResolvedValue(1.231); // → ceil(123.1) = 124 cents
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "USD" })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10000,
      currency: "sats",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(200);
    expect(satsToUSDMock).toHaveBeenCalledWith(10000);
    const charge = createSquarePaymentMock.mock.calls[0][1] as any;
    expect(charge.amount).toBe(124);
    expect(charge.currency).toBe("USD");
  });

  it("charges the location currency at its smallest unit when it matches the cart", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "USD" })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 12.34,
      currency: "usd",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(200);
    const charge = createSquarePaymentMock.mock.calls[0][1] as any;
    expect(charge.amount).toBe(1234);
    expect(charge.currency).toBe("USD");
  });
});

describe("POST /api/square/create-payment — seller resolved server-side", () => {
  it("ignores any client-supplied token/location and charges the server-resolved connection", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({
        accessToken: "server_resolved_token",
        locationId: "L_SERVER",
      })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
      // Attacker-supplied values that must be ignored.
      accessToken: "client_token",
      locationId: "L_CLIENT",
      access_token: "client_token2",
    });
    expect(res.statusCode).toBe(200);
    // The connection is resolved from the pubkey, not the body.
    expect(getValidSquareAccessTokenMock).toHaveBeenCalledWith(SELLER);
    const [token, charge] = createSquarePaymentMock.mock.calls[0] as any[];
    expect(token).toBe("server_resolved_token");
    expect(charge.locationId).toBe("L_SERVER");
  });

  it("returns 400 when the seller has no Square connection", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(null);
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("square_not_connected");
    expect(createSquarePaymentMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/square/create-payment — fail closed on a stale/unavailable exchange rate", () => {
  it("returns 503 with EXCHANGE_RATE_UNAVAILABLE and NEVER charges when satsToUSD throws an exchange-rate error", async () => {
    const { ExchangeRateError } = jest.requireActual("@/utils/stripe/currency");
    satsToUSDMock.mockRejectedValue(new ExchangeRateError());
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "USD" })
    );
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10000,
      currency: "sats",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(503);
    expect((res.body as any).code).toBe("EXCHANGE_RATE_UNAVAILABLE");
    expect((res.body as any).success).toBeUndefined();
    // The buyer is never charged at a wrong/stale rate.
    expect(createSquarePaymentMock).not.toHaveBeenCalled();
  });

  it("maps a generic (non-rate) charge error to 500 WITHOUT the exchange-rate code", async () => {
    createSquarePaymentMock.mockRejectedValue(new Error("Square is down"));
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(500);
    expect((res.body as any).code).toBeUndefined();
    expect((res.body as any).success).toBeUndefined();
  });
});

describe("POST /api/square/create-payment — stable idempotency key dedups a double-tap", () => {
  function keyFromCall(res: any): string {
    expect(res.statusCode).toBe(200);
    const charge = createSquarePaymentMock.mock.calls.at(-1)?.[1] as any;
    return charge.idempotencyKey as string;
  }

  const baseBody = {
    sourceId: "cnon_card",
    amount: 12.34,
    currency: "USD",
    sellerPubkey: SELLER,
    customerEmail: "buyer@example.com",
    productTitle: "Raw milk",
    metadata: { orderId: "order_1" },
  };

  it("produces the SAME key for two identical resubmits (double-tap → one charge)", async () => {
    const key1 = keyFromCall(await callHandler({ ...baseBody }));
    const key2 = keyFromCall(await callHandler({ ...baseBody }));
    expect(key1).toBe(key2);
  });

  it("is insensitive to leading/trailing email whitespace (same checkout, same key)", async () => {
    const key1 = keyFromCall(await callHandler({ ...baseBody }));
    const key2 = keyFromCall(
      await callHandler({ ...baseBody, customerEmail: "  buyer@example.com  " })
    );
    expect(key1).toBe(key2);
  });

  it.each([
    ["a different amount", { amount: 99.99 }],
    ["a different seller", { sellerPubkey: "b".repeat(64) }],
    ["a different email", { customerEmail: "other@example.com" }],
    ["a different product", { productTitle: "Goat milk" }],
    ["different metadata", { metadata: { orderId: "order_2" } }],
  ])("produces a DIFFERENT key for %s", async (_label, over) => {
    const base = keyFromCall(await callHandler({ ...baseBody }));
    const other = keyFromCall(await callHandler({ ...baseBody, ...over }));
    expect(other).not.toBe(base);
  });

  it("produces a DIFFERENT key for a different charge currency", async () => {
    // Same numeric amount but the seller settles a different currency, so the
    // resolved (amountSmallest, chargeCurrency) fingerprint differs.
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "USD" })
    );
    const usdKey = keyFromCall(
      await callHandler({ ...baseBody, currency: "USD" })
    );
    getValidSquareAccessTokenMock.mockResolvedValue(
      usdAccess({ locationCurrency: "EUR" })
    );
    const eurKey = keyFromCall(
      await callHandler({ ...baseBody, currency: "EUR" })
    );
    expect(eurKey).not.toBe(usdKey);
  });

  it("stays within Square's 45-char idempotency cap", async () => {
    const key = keyFromCall(
      await callHandler({
        ...baseBody,
        // Stress the inputs with long values to confirm the hash, not the raw
        // inputs, bounds the key length.
        customerEmail: `${"x".repeat(200)}@example.com`,
        productTitle: "y".repeat(500),
        metadata: { orderId: "z".repeat(500) },
      })
    );
    expect(key.length).toBeLessThanOrEqual(45);
  });
});

describe("POST /api/square/create-payment — fail closed when unconfigured", () => {
  it("returns 503 without resolving any seller connection when Square is unconfigured", async () => {
    isSquareConfiguredMock.mockReturnValue(false);
    const res = await callHandler({
      sourceId: "cnon_card",
      amount: 10,
      currency: "USD",
      sellerPubkey: SELLER,
    });
    expect(res.statusCode).toBe(503);
    expect((res.body as any).code).toBe("square_unconfigured");
    expect(getValidSquareAccessTokenMock).not.toHaveBeenCalled();
    expect(createSquarePaymentMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/square/create-payment — order metadata forwarded to the charge", () => {
  const baseBody = {
    sourceId: "cnon_card",
    amount: 12.34,
    currency: "USD",
    sellerPubkey: SELLER,
    customerEmail: "buyer@example.com",
    productTitle: "Raw milk",
    metadata: { orderId: "order_42" },
  };

  function chargeFrom(res: any) {
    expect(res.statusCode).toBe(200);
    return createSquarePaymentMock.mock.calls.at(-1)?.[1] as any;
  }

  it("forwards referenceId=orderId, buyerEmailAddress, and note=productTitle so the receipt ties back to the order", async () => {
    const charge = chargeFrom(await callHandler({ ...baseBody }));
    expect(charge.referenceId).toBe("order_42");
    expect(charge.buyerEmailAddress).toBe("buyer@example.com");
    expect(charge.note).toBe("Raw milk");
  });

  it("trims surrounding whitespace from the buyer email before forwarding it", async () => {
    const charge = chargeFrom(
      await callHandler({ ...baseBody, customerEmail: "  buyer@example.com  " })
    );
    expect(charge.buyerEmailAddress).toBe("buyer@example.com");
  });

  it("drops a malformed buyer email rather than forwarding it to Square", async () => {
    const charge = chargeFrom(
      await callHandler({ ...baseBody, customerEmail: "not-an-email" })
    );
    expect(charge.buyerEmailAddress).toBeUndefined();
  });

  it("leaves referenceId undefined when no order metadata is supplied", async () => {
    const charge = chargeFrom(
      await callHandler({ ...baseBody, metadata: undefined })
    );
    expect(charge.referenceId).toBeUndefined();
  });

  it("leaves referenceId undefined when metadata.orderId is not a string", async () => {
    const charge = chargeFrom(
      await callHandler({ ...baseBody, metadata: { orderId: 123 } })
    );
    expect(charge.referenceId).toBeUndefined();
  });

  it("omits the note when no productTitle is supplied", async () => {
    const charge = chargeFrom(
      await callHandler({ ...baseBody, productTitle: undefined })
    );
    expect(charge.note).toBeUndefined();
  });
});
