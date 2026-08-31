const getOrderStatusesMock = jest.fn();
const verifyNip98RequestMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getOrderStatuses: (...args: unknown[]) => getOrderStatusesMock(...args),
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

import handler from "@/pages/api/db/get-order-statuses";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const sellerPubkey = "a".repeat(64);

function createRequest(body: unknown, authorization = "Nostr signed") {
  return {
    method: "POST",
    headers: authorization ? { authorization } : {},
    socket: { remoteAddress: "127.0.0.1" },
    body,
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

describe("/api/db/get-order-statuses", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    getOrderStatusesMock.mockReset();
    verifyNip98RequestMock.mockReset().mockResolvedValue({
      ok: true,
      pubkey: sellerPubkey,
    });
  });

  it("requires authentication before returning even an empty status set", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: false,
      error: "Missing Authorization header",
    });
    const req = createRequest({ orderIds: [] }, "");
    const res = createResponse();

    await handler(req, res as any);

    expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "POST", req.body);
    expect(getOrderStatusesMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("scopes status reads to the authenticated seller", async () => {
    getOrderStatusesMock.mockResolvedValue({ "order-1": "confirmed" });
    const req = createRequest({ orderIds: ["order-1"] });
    const res = createResponse();

    await handler(req, res as any);

    expect(getOrderStatusesMock).toHaveBeenCalledWith(
      ["order-1"],
      sellerPubkey
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("rejects GET so signed reads have one unambiguous payload", async () => {
    const req = {
      method: "GET",
      headers: { authorization: "Nostr signed" },
      socket: { remoteAddress: "127.0.0.1" },
      query: { orderIds: "order-1" },
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(405);
    expect(verifyNip98RequestMock).not.toHaveBeenCalled();
  });

  it("rejects malformed order IDs before querying", async () => {
    const req = createRequest({ orderIds: ["order-1", "invalid order id"] });
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Invalid order ID" });
    expect(getOrderStatusesMock).not.toHaveBeenCalled();
  });

  it("deduplicates IDs before querying", async () => {
    getOrderStatusesMock.mockResolvedValue({ "order-1": "shipped" });
    const req = createRequest({
      orderIds: ["order-1", "order-1", " order-2 "],
    });
    const res = createResponse();

    await handler(req, res as any);

    expect(getOrderStatusesMock).toHaveBeenCalledWith(
      ["order-1", "order-2"],
      sellerPubkey
    );
    expect(res.statusCode).toBe(200);
  });

  it("reports a database failure instead of returning false pending state", async () => {
    getOrderStatusesMock.mockRejectedValueOnce(new Error("database offline"));
    const req = createRequest({ orderIds: ["order-1"] });
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ error: "Failed to get order statuses" });
  });
});
