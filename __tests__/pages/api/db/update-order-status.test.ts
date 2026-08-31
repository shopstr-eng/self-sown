const verifyNip98RequestMock = jest.fn();
const transitionSellerOrderStatusMock = jest.fn();

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  transitionSellerOrderStatus: (...args: unknown[]) =>
    transitionSellerOrderStatusMock(...args),
}));

import handler from "@/pages/api/db/update-order-status";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const sellerPubkey = "a".repeat(64);
const buyerPubkey = "b".repeat(64);
const messageId = "1".repeat(64);
const transitionId = "2".repeat(64);

function createRequest(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { authorization: "Nostr signed-authorization" },
    socket: { remoteAddress: "127.0.0.1" },
    body,
  } as any;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-123",
    expectedStatus: "pending",
    status: "confirmed",
    messageId,
    sellerPubkey,
    buyerPubkey,
    transitionId,
    ...overrides,
  };
}

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    setHeader: jest.fn(),
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

describe("/api/db/update-order-status", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    verifyNip98RequestMock.mockReset().mockResolvedValue({
      ok: true,
      pubkey: sellerPubkey,
    });
    transitionSellerOrderStatusMock.mockReset();
  });

  it("passes a payload-bound seller transition to the canonical order state", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({
      outcome: "updated",
      status: "confirmed",
      version: 1,
    });
    const req = createRequest(validBody());
    const res = createResponse();

    await handler(req, res as any);

    expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "POST", req.body);
    expect(transitionSellerOrderStatusMock).toHaveBeenCalledWith({
      actorPubkey: sellerPubkey,
      buyerPubkey,
      expectedStatus: "pending",
      messageId,
      orderId: "order-123",
      sellerPubkey,
      status: "confirmed",
      transitionId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      orderId: "order-123",
      status: "confirmed",
      persisted: true,
      version: 1,
    });
  });

  it("rejects an ephemeral outer author attempting a seller transition", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({ outcome: "forbidden" });
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "e".repeat(64),
    });
    const req = createRequest(validBody());
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "You are not allowed to update this order.",
    });
  });

  it("rejects a buyer attempting a seller-only transition", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({ outcome: "forbidden" });
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: buyerPubkey });
    const req = createRequest(
      validBody({ expectedStatus: "confirmed", status: "shipped" })
    );
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(403);
    expect(transitionSellerOrderStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorPubkey: buyerPubkey, status: "shipped" })
    );
  });

  it("returns conflict for a skipped lifecycle transition", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({
      outcome: "conflict",
      currentStatus: "pending",
    });
    const req = createRequest(
      validBody({ expectedStatus: "pending", status: "shipped" })
    );
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(409);
    expect(res.jsonBody).toEqual({
      error: "Order status changed. Refresh before retrying.",
      currentStatus: "pending",
    });
  });

  it("returns conflict for a concurrent stale write", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({
      outcome: "conflict",
      currentStatus: "confirmed",
    });
    const req = createRequest(validBody());
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(409);
    expect(res.jsonBody).toEqual({
      error: "Order status changed. Refresh before retrying.",
      currentStatus: "confirmed",
    });
  });

  it("accepts an exact idempotent retry without another transition", async () => {
    transitionSellerOrderStatusMock.mockResolvedValue({
      outcome: "idempotent",
      status: "confirmed",
      version: 1,
    });
    const req = createRequest(validBody());
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      orderId: "order-123",
      status: "confirmed",
      persisted: true,
      version: 1,
    });
  });

  it.each([
    [{ messageId: "not-an-event-id" }, "Invalid messageId"],
    [{ sellerPubkey: "not-a-pubkey" }, "Invalid sellerPubkey"],
    [{ buyerPubkey: "not-a-pubkey" }, "Invalid buyerPubkey"],
    [{ transitionId: "bad transition id" }, "Invalid transitionId"],
    [{ expectedStatus: "unknown" }, "Invalid status transition"],
    [{ orderId: "invalid order id" }, "Invalid orderId"],
  ])("rejects malformed transition input %#", async (override, error) => {
    const req = createRequest(validBody(override));
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error });
    expect(transitionSellerOrderStatusMock).not.toHaveBeenCalled();
  });
});
