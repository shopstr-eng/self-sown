const verifyNip98RequestMock = jest.fn();
const getOrderParticipantsMock = jest.fn();
const updateOrderStatusMock = jest.fn();

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getOrderParticipants: (...args: unknown[]) =>
    getOrderParticipantsMock(...args),
  updateOrderStatus: (...args: unknown[]) => updateOrderStatusMock(...args),
}));

import handler from "@/pages/api/db/update-order-status";

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

describe("/api/db/update-order-status", () => {
  beforeEach(() => {
    verifyNip98RequestMock.mockReset();
    getOrderParticipantsMock.mockReset();
    updateOrderStatusMock.mockReset();
  });

  it("authorizes status changes using the target order participants only", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "buyer-on-target-order",
    });
    getOrderParticipantsMock.mockResolvedValue({
      buyerPubkey: "buyer-on-target-order",
      sellerPubkey: "seller-on-target-order",
    });

    const req = {
      method: "POST",
      body: {
        orderId: "order-123",
        status: "shipped",
        messageId: "foreign-message-id",
      },
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(getOrderParticipantsMock).toHaveBeenCalledWith("order-123");
    expect(updateOrderStatusMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error:
        "You are not allowed to set this order status for the current order role.",
    });
  });

  it("persists the status when participants can't be resolved (encrypted gift wraps)", async () => {
    // Order messages are gift wraps, so getOrderParticipants normally returns
    // nulls. The endpoint must NOT 404 — it delegates to updateOrderStatus,
    // whose per-row ownership check (author/p-tag) is the real authority.
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "seller-pubkey",
    });
    getOrderParticipantsMock.mockResolvedValue({
      buyerPubkey: null,
      sellerPubkey: null,
    });
    updateOrderStatusMock.mockResolvedValue(1);

    const req = {
      method: "POST",
      body: {
        orderId: "order-123",
        status: "shipped",
        messageId: "wrap-event-id",
      },
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(updateOrderStatusMock).toHaveBeenCalledWith(
      "order-123",
      "shipped",
      "seller-pubkey",
      "wrap-event-id"
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      orderId: "order-123",
      status: "shipped",
      persisted: true,
    });
  });

  it("still persists even if resolving participants throws", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "seller-pubkey",
    });
    getOrderParticipantsMock.mockRejectedValue(new Error("db down"));
    updateOrderStatusMock.mockResolvedValue(0);

    const req = {
      method: "POST",
      body: {
        orderId: "order-123",
        status: "shipped",
        messageId: "wrap-event-id",
      },
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(updateOrderStatusMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      orderId: "order-123",
      status: "shipped",
      persisted: false,
    });
  });
});
