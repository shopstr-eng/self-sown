/** @jest-environment node */

const applyRateLimitMock = jest.fn();
const claimStripeEventMock = jest.fn();
const releaseStripeEventMock = jest.fn();
const constructEventMock = jest.fn();
const isProMembershipSubscriptionMock = jest.fn();
const applyStripeLifetimePaymentMock = jest.fn();
const applyStripeSubscriptionToMembershipMock = jest.fn();
const sendProStripeReceiptEmailMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/stripe/processed-events", () => ({
  claimStripeEvent: (...args: unknown[]) => claimStripeEventMock(...args),
  releaseStripeEvent: (...args: unknown[]) => releaseStripeEventMock(...args),
}));

jest.mock("@/utils/pro/stripe-pro", () => ({
  getProStripe: () => ({
    webhooks: {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    },
  }),
  isProMembershipSubscription: (...args: unknown[]) =>
    isProMembershipSubscriptionMock(...args),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
}));

jest.mock("@/utils/pro/membership", () => ({
  applyStripeLifetimePayment: (...args: unknown[]) =>
    applyStripeLifetimePaymentMock(...args),
  applyStripeSubscriptionToMembership: (...args: unknown[]) =>
    applyStripeSubscriptionToMembershipMock(...args),
  sendProStripeReceiptEmail: (...args: unknown[]) =>
    sendProStripeReceiptEmailMock(...args),
}));

import handler from "@/pages/api/pro/stripe-webhook";

function createRequest() {
  return {
    method: "POST",
    headers: { "stripe-signature": "test-sig" },
    on(event: string, cb: (arg?: unknown) => void) {
      // getRawBody attaches data/end/error listeners; resolve with empty body.
      if (event === "end") cb();
      return this;
    },
  } as any;
}

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

describe("/api/pro/stripe-webhook release-on-failure retry", () => {
  const originalSecret = process.env.STRIPE_PRO_WEBHOOK_SECRET;

  beforeEach(() => {
    applyRateLimitMock.mockReset().mockReturnValue(true);
    claimStripeEventMock.mockReset().mockResolvedValue(true);
    releaseStripeEventMock.mockReset().mockResolvedValue(undefined);
    constructEventMock.mockReset();
    isProMembershipSubscriptionMock.mockReset().mockReturnValue(false);
    applyStripeLifetimePaymentMock.mockReset().mockResolvedValue(undefined);
    applyStripeSubscriptionToMembershipMock
      .mockReset()
      .mockResolvedValue(undefined);
    sendProStripeReceiptEmailMock.mockReset().mockResolvedValue(undefined);
    process.env.STRIPE_PRO_WEBHOOK_SECRET = "whsec_test";
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
  });

  afterAll(() => {
    process.env.STRIPE_PRO_WEBHOOK_SECRET = originalSecret;
  });

  it("releases the claim and responds 500 when the lifetime handler throws", async () => {
    const pi = {
      id: "pi_test",
      metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
    };
    constructEventMock.mockReturnValue({
      id: "evt_lifetime_fail",
      type: "payment_intent.succeeded",
      data: { object: pi },
    });
    applyStripeLifetimePaymentMock.mockRejectedValue(new Error("db down"));

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(500);
    expect(applyStripeLifetimePaymentMock).toHaveBeenCalledTimes(1);
    expect(releaseStripeEventMock).toHaveBeenCalledTimes(1);
    expect(releaseStripeEventMock).toHaveBeenCalledWith("evt_lifetime_fail");
  });

  it("releases the claim and responds 500 when the subscription handler throws", async () => {
    const subscription = { id: "sub_test" };
    constructEventMock.mockReturnValue({
      id: "evt_sub_fail",
      type: "customer.subscription.updated",
      data: { object: subscription },
    });
    isProMembershipSubscriptionMock.mockReturnValue(true);
    applyStripeSubscriptionToMembershipMock.mockRejectedValue(
      new Error("db down")
    );

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(500);
    expect(applyStripeSubscriptionToMembershipMock).toHaveBeenCalledTimes(1);
    expect(releaseStripeEventMock).toHaveBeenCalledTimes(1);
    expect(releaseStripeEventMock).toHaveBeenCalledWith("evt_sub_fail");
  });

  it("does NOT release the claim when the handler succeeds", async () => {
    const pi = {
      id: "pi_test",
      metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
    };
    constructEventMock.mockReturnValue({
      id: "evt_ok",
      type: "payment_intent.succeeded",
      data: { object: pi },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).toHaveBeenCalledTimes(1);
    expect(releaseStripeEventMock).not.toHaveBeenCalled();
  });
});
