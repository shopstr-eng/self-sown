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

describe("/api/pro/stripe-webhook dedup short-circuit", () => {
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
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
  });

  afterAll(() => {
    process.env.STRIPE_PRO_WEBHOOK_SECRET = originalSecret;
  });

  it("responds 200 deduped and runs no downstream logic when the claim is already taken", async () => {
    // A lifetime PaymentIntent that WOULD grant benefits if it weren't deduped.
    const pi = {
      id: "pi_test",
      metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
    };
    constructEventMock.mockReturnValue({
      id: "evt_already_processed",
      type: "payment_intent.succeeded",
      data: { object: pi },
    });
    // The event has already been processed on a prior delivery.
    claimStripeEventMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ received: true, deduped: true });

    // None of the membership side effects may run for a duplicate event.
    expect(applyStripeLifetimePaymentMock).not.toHaveBeenCalled();
    expect(applyStripeSubscriptionToMembershipMock).not.toHaveBeenCalled();
    expect(sendProStripeReceiptEmailMock).not.toHaveBeenCalled();

    // A short-circuited event must not release the claim it never owned.
    expect(releaseStripeEventMock).not.toHaveBeenCalled();
  });
});
