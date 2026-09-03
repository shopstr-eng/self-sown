/** @jest-environment node */

// Route-level coverage for the Pro webhook's invoice branch: receipts must only
// be attempted for genuine Pro membership invoices. Non-Pro subscriptions on
// the platform account have no membership row BY DESIGN, so without this gate
// every non-Pro invoice would trip the ORPHANED_PRO_RECEIPT marker inside
// sendProStripeReceiptEmail and drown the genuine orphan signal.

const applyRateLimitMock = jest.fn();
const claimStripeEventMock = jest.fn();
const finalizeStripeEventMock = jest.fn();
const releaseStripeEventMock = jest.fn();
const constructEventMock = jest.fn();
const subscriptionsRetrieveMock = jest.fn();
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
    subscriptions: {
      retrieve: (...args: unknown[]) => subscriptionsRetrieveMock(...args),
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

const SUB_ID = "sub_pro_123";

function invoiceSucceededEvent() {
  return {
    id: "evt_pro_invoice",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: "in_pro_paid",
        subscription: SUB_ID,
        amount_paid: 3000,
        currency: "usd",
      },
    },
  };
}

describe("/api/pro/stripe-webhook — invoice.payment_succeeded Pro gating", () => {
  const originalSecret = process.env.STRIPE_PRO_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    applyRateLimitMock.mockResolvedValue(true);
    claimStripeEventMock.mockResolvedValue(true);
    finalizeStripeEventMock.mockResolvedValue(undefined);
    releaseStripeEventMock.mockResolvedValue(undefined);
    applyStripeSubscriptionToMembershipMock.mockResolvedValue(undefined);
    sendProStripeReceiptEmailMock.mockResolvedValue(undefined);
    subscriptionsRetrieveMock.mockResolvedValue({ id: SUB_ID });
    process.env.STRIPE_PRO_WEBHOOK_SECRET = "whsec_test";
  });

  afterAll(() => {
    process.env.STRIPE_PRO_WEBHOOK_SECRET = originalSecret;
  });

  it("syncs membership and sends the receipt (with the event id) for a Pro invoice", async () => {
    constructEventMock.mockReturnValue(invoiceSucceededEvent());
    isProMembershipSubscriptionMock.mockReturnValue(true);

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeSubscriptionToMembershipMock).toHaveBeenCalledWith(
      { id: SUB_ID },
      { eventId: "evt_pro_invoice" }
    );
    expect(sendProStripeReceiptEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "in_pro_paid" }),
      { eventId: "evt_pro_invoice" }
    );
    expect(finalizeStripeEventMock).toHaveBeenCalledWith("evt_pro_invoice");
  });

  it("skips the receipt entirely for a non-Pro subscription invoice", async () => {
    constructEventMock.mockReturnValue(invoiceSucceededEvent());
    isProMembershipSubscriptionMock.mockReturnValue(false);

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(applyStripeSubscriptionToMembershipMock).not.toHaveBeenCalled();
    expect(sendProStripeReceiptEmailMock).not.toHaveBeenCalled();
    expect(finalizeStripeEventMock).toHaveBeenCalledWith("evt_pro_invoice");
  });

  it("500s and releases the event claim when the membership sync throws, so Stripe retries", async () => {
    constructEventMock.mockReturnValue(invoiceSucceededEvent());
    isProMembershipSubscriptionMock.mockReturnValue(true);
    applyStripeSubscriptionToMembershipMock.mockRejectedValue(
      new Error("db down")
    );

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(500);
    expect(releaseStripeEventMock).toHaveBeenCalledWith("evt_pro_invoice");
    expect(sendProStripeReceiptEmailMock).not.toHaveBeenCalled();
  });
});
