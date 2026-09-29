/** @jest-environment node */

// Regression: the route used to forward raw req.body fields into the email
// templates, so a numeric `amount` (or any non-string field) crashed the
// template escaping (".replace is not a function") and BOTH buyer and seller
// order emails were dropped with a 500. The boundary must coerce numeric
// scalars, drop non-string fields, and 400 on non-string orderId/productTitle.

const sendOrderConfirmationToBuyerMock = jest.fn();
const sendNewOrderToSellerMock = jest.fn();
const applyRateLimitMock = jest.fn();
const loadStorefrontBrandingMock = jest.fn();
const resolveSellerSenderEmailMock = jest.fn();
const saveNotificationEmailMock = jest.fn();
const getSellerNotificationEmailMock = jest.fn();
const getUserAuthEmailMock = jest.fn();
const recordEmailFlowConversionMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    paymentIntents: { retrieve: jest.fn() },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/email/email-service", () => ({
  sendOrderConfirmationToBuyer: (...args: unknown[]) =>
    sendOrderConfirmationToBuyerMock(...args),
  sendNewOrderToSeller: (...args: unknown[]) =>
    sendNewOrderToSellerMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // utils/db/* call getDbPool() at module scope in their real implementations;
  // the mock must provide it or importing the route kills the suite.
  getDbPool: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  saveNotificationEmail: (...args: unknown[]) =>
    saveNotificationEmailMock(...args),
  getSellerNotificationEmail: (...args: unknown[]) =>
    getSellerNotificationEmailMock(...args),
  getUserAuthEmail: (...args: unknown[]) => getUserAuthEmailMock(...args),
  getEmailFlows: jest.fn().mockResolvedValue([]),
  getFlowEnrollments: jest.fn().mockResolvedValue([]),
  enrollInFlow: jest.fn(),
  scheduleStepExecutions: jest.fn(),
  recordEmailFlowConversion: (...args: unknown[]) =>
    recordEmailFlowConversionMock(...args),
}));

jest.mock("@/utils/db/inventory-service", () => ({ deductStock: jest.fn() }));
jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: (...args: unknown[]) =>
    loadStorefrontBrandingMock(...args),
}));
jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: (...args: unknown[]) =>
    resolveSellerSenderEmailMock(...args),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));
jest.mock("@/utils/messages/order-message-utils", () => ({
  resolveExplicitPaymentMethod: jest.fn().mockReturnValue("Card"),
}));

import handler from "@/pages/api/email/send-order-email";
import type { NextApiRequest, NextApiResponse } from "next";

function mockRes() {
  const res = {
    statusCode: 0,
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

describe("POST /api/email/send-order-email body coercion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    applyRateLimitMock.mockResolvedValue(true);
    loadStorefrontBrandingMock.mockResolvedValue(null);
    resolveSellerSenderEmailMock.mockResolvedValue(null);
    getSellerNotificationEmailMock.mockResolvedValue(null);
    getUserAuthEmailMock.mockResolvedValue(null);
    saveNotificationEmailMock.mockResolvedValue(undefined);
    recordEmailFlowConversionMock.mockResolvedValue(undefined);
    sendOrderConfirmationToBuyerMock.mockResolvedValue(true);
    sendNewOrderToSellerMock.mockResolvedValue(true);
  });

  it("coerces numeric fields instead of crashing the templates", async () => {
    const res = mockRes();
    await handler(
      {
        method: "POST",
        body: {
          orderId: "order-abc123",
          productTitle: "Raw Milk",
          amount: 21,
          quantity: 2,
          buyerEmail: "buyer@example.com",
          buyerName: { first: "Ada" },
          selectedBulkOption: 3,
        },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.statusCode).toBe(200);
    expect(sendOrderConfirmationToBuyerMock).toHaveBeenCalledTimes(1);
    const call = sendOrderConfirmationToBuyerMock.mock.calls[0]!;
    expect(call[0]).toBe("buyer@example.com");
    expect(call[1].amount).toBe("21");
    expect(call[1].selectedBulkOption).toBe("3");
    expect(call[1].buyerName).toBeUndefined();
  });

  it("rejects a non-string orderId with 400", async () => {
    const res = mockRes();
    await handler(
      {
        method: "POST",
        body: { orderId: 123, productTitle: "Raw Milk" },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.statusCode).toBe(400);
    expect(sendOrderConfirmationToBuyerMock).not.toHaveBeenCalled();
  });

  it("ignores a non-string buyerEmail and still returns 200", async () => {
    const res = mockRes();
    await handler(
      {
        method: "POST",
        body: {
          orderId: "order-abc123",
          productTitle: "Raw Milk",
          buyerEmail: { address: "buyer@example.com" },
        },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.statusCode).toBe(200);
    expect(sendOrderConfirmationToBuyerMock).not.toHaveBeenCalled();
    expect(sendNewOrderToSellerMock).not.toHaveBeenCalled();
  });
});
