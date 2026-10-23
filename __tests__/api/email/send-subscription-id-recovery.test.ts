/** @jest-environment node */

// Returning-guest recovery path: the guest subscription lookup requires the
// Stripe subscription ID, so a guest who lost it can ask the server to email
// their ID(s) to the address on file. The route must (1) send the real IDs to
// that address, and (2) never reveal through its response whether the email
// has any subscriptions.

const sendSubscriptionIdRecoveryMock = jest.fn();

jest.mock("@/utils/email/email-service", () => ({
  sendSubscriptionConfirmation: jest.fn(),
  sendRenewalReminder: jest.fn(),
  sendSubscriptionIdRecovery: (...args: unknown[]) =>
    sendSubscriptionIdRecoveryMock(...args),
  sendAddressChangeConfirmation: jest.fn(),
  sendSubscriptionCancellation: jest.fn(),
}));

const getSubscriptionsByBuyerEmailMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  getSubscriptionByStripeId: jest.fn(),
  getSubscriptionsByBuyerEmail: (...args: unknown[]) =>
    getSubscriptionsByBuyerEmailMock(...args),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(),
}));

import handler from "@/pages/api/email/send-subscription-email";

function makeRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

function makeReq(body: Record<string, unknown>) {
  return { method: "POST", body, headers: {} } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/email/send-subscription-email type=id_recovery", () => {
  it("emails the full subscription IDs to the address on file", async () => {
    getSubscriptionsByBuyerEmailMock.mockResolvedValue([
      {
        stripe_subscription_id: "sub_secret_1N23",
        product_title: "Raw Milk",
        product_event_id: "evt_1",
      },
    ]);
    sendSubscriptionIdRecoveryMock.mockResolvedValue(true);

    const res = makeRes();
    await handler(
      makeReq({ type: "id_recovery", buyerEmail: "Buyer@Example.com" }),
      res
    );

    // Lookup normalizes the email before querying.
    expect(getSubscriptionsByBuyerEmailMock).toHaveBeenCalledWith(
      "buyer@example.com"
    );
    expect(sendSubscriptionIdRecoveryMock).toHaveBeenCalledWith(
      "Buyer@Example.com",
      {
        subscriptions: [
          { subscriptionId: "sub_secret_1N23", productTitle: "Raw Milk" },
        ],
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns the same success shape when the email has no subscriptions", async () => {
    getSubscriptionsByBuyerEmailMock.mockResolvedValue([]);

    const res = makeRes();
    await handler(
      makeReq({ type: "id_recovery", buyerEmail: "nobody@example.com" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(sendSubscriptionIdRecoveryMock).not.toHaveBeenCalled();
  });

  it("still requires buyerEmail", async () => {
    const res = makeRes();
    await handler(makeReq({ type: "id_recovery" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getSubscriptionsByBuyerEmailMock).not.toHaveBeenCalled();
  });
});
