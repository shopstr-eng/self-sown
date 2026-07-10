/** @jest-environment node */

const applyRateLimitMock = jest.fn();
const claimStripeEventMock = jest.fn();
const finalizeStripeEventMock = jest.fn();
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
  finalizeStripeEvent: (...args: unknown[]) => finalizeStripeEventMock(...args),
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

function paymentIntentEvent(metadata: Record<string, string>) {
  return {
    id: "evt_test",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_test", metadata } },
  };
}

describe("/api/pro/stripe-webhook lifetime payment guard", () => {
  const originalSecret = process.env.STRIPE_PRO_WEBHOOK_SECRET;

  beforeEach(() => {
    applyRateLimitMock.mockReset().mockReturnValue(true);
    claimStripeEventMock.mockReset().mockResolvedValue(true);
    finalizeStripeEventMock.mockReset().mockResolvedValue(undefined);
    releaseStripeEventMock.mockReset().mockResolvedValue(undefined);
    constructEventMock.mockReset();
    isProMembershipSubscriptionMock.mockReset().mockReturnValue(false);
    applyStripeLifetimePaymentMock.mockReset().mockResolvedValue(undefined);
    applyStripeSubscriptionToMembershipMock
      .mockReset()
      .mockResolvedValue(undefined);
    sendProStripeReceiptEmailMock.mockReset().mockResolvedValue(undefined);
    process.env.STRIPE_PRO_WEBHOOK_SECRET = "whsec_test";
  });

  afterAll(() => {
    process.env.STRIPE_PRO_WEBHOOK_SECRET = originalSecret;
  });

  it("grants lifetime for a PaymentIntent tagged with both proLifetime and mmProPubkey", async () => {
    const pi = {
      id: "pi_test",
      metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
    };
    constructEventMock.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: { object: pi },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).toHaveBeenCalledTimes(1);
    expect(applyStripeLifetimePaymentMock).toHaveBeenCalledWith(pi);
    expect(finalizeStripeEventMock).toHaveBeenCalledWith("evt_test");
  });

  it("ignores a PaymentIntent missing the mmProPubkey tag", async () => {
    constructEventMock.mockReturnValue(
      paymentIntentEvent({ proLifetime: "true" })
    );

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).not.toHaveBeenCalled();
  });

  it("ignores a PaymentIntent missing the proLifetime tag", async () => {
    constructEventMock.mockReturnValue(
      paymentIntentEvent({ mmProPubkey: "seller-pubkey" })
    );

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).not.toHaveBeenCalled();
  });

  it("ignores a PaymentIntent with proLifetime set to a non-true value", async () => {
    constructEventMock.mockReturnValue(
      paymentIntentEvent({ proLifetime: "false", mmProPubkey: "seller-pubkey" })
    );

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).not.toHaveBeenCalled();
  });

  it("ignores an untagged PaymentIntent", async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent({}));

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeLifetimePaymentMock).not.toHaveBeenCalled();
  });
});
