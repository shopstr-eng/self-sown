const applyRateLimitMock = jest.fn();
const verifySignedHttpRequestProofMock = jest.fn();
const extractSignedEventFromRequestMock = jest.fn();
const checkoutSessionsCreateMock = jest.fn();
const ensureProPriceMock = jest.fn();
const ensureWranglerLifetimePriceMock = jest.fn();
const getOrCreateProCustomerMock = jest.fn();
const getProMembershipMock = jest.fn();
const getSellerNotificationEmailMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/nostr/request-auth", () => ({
  verifySignedHttpRequestProof: (...args: unknown[]) =>
    verifySignedHttpRequestProofMock(...args),
  extractSignedEventFromRequest: (...args: unknown[]) =>
    extractSignedEventFromRequestMock(...args),
  buildProCheckoutSessionProof: jest.fn((input: unknown) => ({
    action: "create_pro_checkout_session",
    input,
  })),
}));

jest.mock("@/utils/pro/stripe-pro", () => ({
  getProStripe: () => ({
    checkout: { sessions: { create: checkoutSessionsCreateMock } },
  }),
  ensureProPrice: (...args: unknown[]) => ensureProPriceMock(...args),
  ensureWranglerLifetimePrice: (...args: unknown[]) =>
    ensureWranglerLifetimePriceMock(...args),
  getOrCreateProCustomer: (...args: unknown[]) =>
    getOrCreateProCustomerMock(...args),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
}));

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: (...args: unknown[]) =>
    getSellerNotificationEmailMock(...args),
}));

jest.mock("@/utils/site-url", () => ({
  getSiteUrl: () => "https://self-sown.test",
}));

import handler from "@/pages/api/pro/checkout-session";

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
}

function createRequest(body: Record<string, unknown>) {
  return { method: "POST", headers: {}, body };
}

const PUBKEY = "a".repeat(64);

describe("pro checkout-session API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    applyRateLimitMock.mockResolvedValue(true);
    verifySignedHttpRequestProofMock.mockReturnValue({ ok: true });
    extractSignedEventFromRequestMock.mockReturnValue({ id: "evt" });
    getProMembershipMock.mockResolvedValue(null);
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");
    getOrCreateProCustomerMock.mockResolvedValue("cus_123");
    ensureProPriceMock.mockResolvedValue("price_recurring");
    ensureWranglerLifetimePriceMock.mockResolvedValue("price_lifetime");
    checkoutSessionsCreateMock.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
  });

  it("rejects non-POST methods", async () => {
    const res = createResponse();
    await handler(
      { method: "GET", headers: {}, body: {} } as never,
      res as never
    );
    expect(res.statusCode).toBe(405);
  });

  it("rejects an invalid plan", async () => {
    const res = createResponse();
    await handler(
      createRequest({ pubkey: PUBKEY, plan: "weekly" }) as never,
      res as never
    );
    expect(res.statusCode).toBe(400);
    expect(checkoutSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects when the signed proof fails verification", async () => {
    verifySignedHttpRequestProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error: "nope",
    });
    const res = createResponse();
    await handler(
      createRequest({ pubkey: PUBKEY, plan: "monthly" }) as never,
      res as never
    );
    expect(res.statusCode).toBe(401);
    expect(checkoutSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects redirect URLs outside the scheme allowlist", async () => {
    const res = createResponse();
    await handler(
      createRequest({
        pubkey: PUBKEY,
        plan: "monthly",
        successUrl: "javascript:alert(1)",
      }) as never,
      res as never
    );
    expect(res.statusCode).toBe(400);
    expect(checkoutSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("blocks a lifetime member from buying again", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    const res = createResponse();
    await handler(
      createRequest({ pubkey: PUBKEY, plan: "lifetime" }) as never,
      res as never
    );
    expect(res.statusCode).toBe(400);
    expect(checkoutSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("blocks a second subscription while one is active", async () => {
    getProMembershipMock.mockResolvedValue({
      lifetime: false,
      status: "active",
      stripe_subscription_id: "sub_live",
    });
    const res = createResponse();
    await handler(
      createRequest({ pubkey: PUBKEY, plan: "yearly" }) as never,
      res as never
    );
    expect(res.statusCode).toBe(400);
    expect(checkoutSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("creates a subscription-mode session with webhook-bound metadata", async () => {
    const res = createResponse();
    await handler(
      createRequest({
        pubkey: PUBKEY,
        plan: "yearly",
        successUrl: "selfsown://pro-return?status=success",
        cancelUrl: "selfsown://pro-return?status=cancel",
      }) as never,
      res as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    expect(ensureProPriceMock).toHaveBeenCalledWith("yearly");
    const [params] = checkoutSessionsCreateMock.mock.calls[0];
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_123",
      line_items: [{ price: "price_recurring", quantity: 1 }],
      success_url: "selfsown://pro-return?status=success",
      cancel_url: "selfsown://pro-return?status=cancel",
      subscription_data: {
        metadata: {
          proMembership: "true",
          ssProPubkey: PUBKEY,
          term: "yearly",
        },
      },
    });
  });

  it("creates a payment-mode session for the lifetime plan", async () => {
    const res = createResponse();
    await handler(
      createRequest({ pubkey: PUBKEY, plan: "lifetime" }) as never,
      res as never
    );

    expect(res.statusCode).toBe(200);
    expect(ensureWranglerLifetimePriceMock).toHaveBeenCalled();
    const [params] = checkoutSessionsCreateMock.mock.calls[0];
    expect(params).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_lifetime", quantity: 1 }],
      payment_intent_data: {
        metadata: { proLifetime: "true", ssProPubkey: PUBKEY },
      },
    });
    // Default redirects point back at the web app.
    expect(params.success_url).toBe("https://self-sown.test/pro?checkout=success");
  });
});
