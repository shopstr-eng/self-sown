import { nip19 } from "nostr-tools";

const verifyNip98RequestMock = jest.fn();
const sendInquiryNotificationMock = jest.fn();
const sendReturnRequestToSellerMock = jest.fn();
const getSellerNotificationEmailMock = jest.fn();
const getUserAuthEmailMock = jest.fn();
const resolveSellerSenderEmailMock = jest.fn();
const loadStorefrontBrandingMock = jest.fn();

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendInquiryNotification: (...args: unknown[]) =>
    sendInquiryNotificationMock(...args),
  sendReturnRequestToSeller: (...args: unknown[]) =>
    sendReturnRequestToSellerMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: (...args: unknown[]) =>
    getSellerNotificationEmailMock(...args),
  getUserAuthEmail: (...args: unknown[]) => getUserAuthEmailMock(...args),
}));

jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: (...args: unknown[]) =>
    resolveSellerSenderEmailMock(...args),
}));

jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: (...args: unknown[]) =>
    loadStorefrontBrandingMock(...args),
}));

import inquiryHandler from "@/pages/api/email/send-inquiry-email";
import returnRequestHandler from "@/pages/api/email/send-return-request-email";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const sender = "a".repeat(64);
const recipient = "b".repeat(64);

function createRequest(body: unknown, authed = true) {
  return {
    method: "POST",
    headers: authed ? { authorization: "Nostr signed-proof" } : {},
    socket: { remoteAddress: "127.0.0.1" },
    body,
    query: {},
  } as any;
}

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
}

describe("/api/email/send-inquiry-email", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    jest.clearAllMocks();
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: sender });
    getSellerNotificationEmailMock.mockResolvedValue(null);
    getUserAuthEmailMock.mockResolvedValue("seller@example.com");
    resolveSellerSenderEmailMock.mockResolvedValue(null);
    loadStorefrontBrandingMock.mockResolvedValue({});
    sendInquiryNotificationMock.mockResolvedValue(true);
  });

  const body = {
    senderPubkey: sender,
    recipientPubkey: recipient,
    message: "Is this still available?",
    senderName: "Buyer",
  };

  it("rejects unauthenticated requests", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: false,
      error: "Missing NIP-98 authorization header",
    });
    const res = createResponse();
    await inquiryHandler(createRequest(body, false), res as any);
    expect(res.statusCode).toBe(401);
    expect(sendInquiryNotificationMock).not.toHaveBeenCalled();
  });

  it("rejects sending as someone other than the signer", async () => {
    const res = createResponse();
    await inquiryHandler(
      createRequest({ ...body, senderPubkey: recipient }),
      res as any
    );
    expect(res.statusCode).toBe(403);
    expect(sendInquiryNotificationMock).not.toHaveBeenCalled();
  });

  it("sends when the sender signs", async () => {
    const res = createResponse();
    await inquiryHandler(createRequest(body), res as any);
    expect(res.statusCode).toBe(200);
    expect(sendInquiryNotificationMock).toHaveBeenCalled();
  });
});

describe("/api/email/send-return-request-email", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    jest.clearAllMocks();
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: sender });
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");
    getUserAuthEmailMock.mockResolvedValue(null);
    resolveSellerSenderEmailMock.mockResolvedValue(null);
    loadStorefrontBrandingMock.mockResolvedValue({});
    sendReturnRequestToSellerMock.mockResolvedValue(true);
  });

  const body = {
    orderId: "order-1",
    productTitle: "Raw Milk",
    requestType: "return",
    message: "Arrived spoiled",
    sellerPubkey: recipient,
    buyerName: nip19.npubEncode(sender),
  };

  it("rejects unauthenticated requests", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: false,
      error: "Missing NIP-98 authorization header",
    });
    const res = createResponse();
    await returnRequestHandler(createRequest(body, false), res as any);
    expect(res.statusCode).toBe(401);
    expect(sendReturnRequestToSellerMock).not.toHaveBeenCalled();
  });

  it("rejects when buyerName is someone else's npub", async () => {
    const res = createResponse();
    await returnRequestHandler(
      createRequest({ ...body, buyerName: nip19.npubEncode(recipient) }),
      res as any
    );
    expect(res.statusCode).toBe(403);
    expect(sendReturnRequestToSellerMock).not.toHaveBeenCalled();
  });

  it("sends when the requester signs as themselves", async () => {
    const res = createResponse();
    await returnRequestHandler(createRequest(body), res as any);
    expect(res.statusCode).toBe(200);
    expect(sendReturnRequestToSellerMock).toHaveBeenCalled();
  });
});
