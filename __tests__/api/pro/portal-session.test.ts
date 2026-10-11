const applyRateLimitMock = jest.fn();
const verifySignedHttpRequestProofMock = jest.fn();
const extractSignedEventFromRequestMock = jest.fn();
const portalSessionsCreateMock = jest.fn();
const getProMembershipMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/nostr/request-auth", () => ({
  verifySignedHttpRequestProof: (...args: unknown[]) =>
    verifySignedHttpRequestProofMock(...args),
  extractSignedEventFromRequest: (...args: unknown[]) =>
    extractSignedEventFromRequestMock(...args),
  buildProPortalSessionProof: jest.fn((pubkey: unknown) => ({
    action: "create_pro_portal_session",
    pubkey,
  })),
}));

jest.mock("@/utils/pro/stripe-pro", () => ({
  getProStripe: () => ({
    billingPortal: { sessions: { create: portalSessionsCreateMock } },
  }),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
}));

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
}));

jest.mock("@/utils/site-url", () => ({
  getSiteUrl: () => "https://self-sown.test",
}));

import handler from "@/pages/api/pro/portal-session";

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

const PUBKEY = "b".repeat(64);

describe("pro portal-session API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    applyRateLimitMock.mockResolvedValue(true);
    verifySignedHttpRequestProofMock.mockReturnValue({ ok: true });
    extractSignedEventFromRequestMock.mockReturnValue({ id: "evt" });
    getProMembershipMock.mockResolvedValue({
      stripe_customer_id: "cus_123",
    });
    portalSessionsCreateMock.mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test_123",
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

  it("rejects when the signed proof fails verification", async () => {
    verifySignedHttpRequestProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error: "nope",
    });
    const res = createResponse();
    await handler(
      { method: "POST", headers: {}, body: { pubkey: PUBKEY } } as never,
      res as never
    );
    expect(res.statusCode).toBe(401);
    expect(portalSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("404s when the seller has no Stripe customer on file", async () => {
    getProMembershipMock.mockResolvedValue(null);
    const res = createResponse();
    await handler(
      { method: "POST", headers: {}, body: { pubkey: PUBKEY } } as never,
      res as never
    );
    expect(res.statusCode).toBe(404);
    expect(portalSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a non-https return URL (no app deep links into the portal)", async () => {
    const res = createResponse();
    await handler(
      {
        method: "POST",
        headers: {},
        body: { pubkey: PUBKEY, returnUrl: "selfsown://pro-return" },
      } as never,
      res as never
    );
    expect(res.statusCode).toBe(400);
    expect(portalSessionsCreateMock).not.toHaveBeenCalled();
  });

  it("creates a portal session with the default return URL", async () => {
    const res = createResponse();
    await handler(
      { method: "POST", headers: {}, body: { pubkey: PUBKEY } } as never,
      res as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      url: "https://billing.stripe.com/p/session/test_123",
    });
    expect(portalSessionsCreateMock).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://self-sown.test/settings/payments",
    });
  });
});
