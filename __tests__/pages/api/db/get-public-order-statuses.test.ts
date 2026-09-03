const getOrderStatusesMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getOrderStatuses: (...args: unknown[]) => getOrderStatusesMock(...args),
}));

import handler from "@/pages/api/db/get-public-order-statuses";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const sellerPubkey = "a".repeat(64);

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

describe("/api/db/get-public-order-statuses", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    getOrderStatusesMock.mockReset();
  });

  it("requires a seller namespace and exact bearer order IDs", async () => {
    getOrderStatusesMock.mockResolvedValue({ "order-1": "confirmed" });
    const req = {
      method: "POST",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body: { sellerPubkey, orderIds: ["order-1"] },
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(getOrderStatusesMock).toHaveBeenCalledWith(
      ["order-1"],
      sellerPubkey
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it.each([
    [{ sellerPubkey: "bad", orderIds: ["order-1"] }, "Invalid sellerPubkey"],
    [{ sellerPubkey, orderIds: ["invalid order id"] }, "Invalid order ID"],
    [{ sellerPubkey, orderIds: "order-1" }, "Invalid orderIds"],
  ])("rejects malformed public lookup input %#", async (body, error) => {
    const req = {
      method: "POST",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body,
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error });
    expect(getOrderStatusesMock).not.toHaveBeenCalled();
  });
});
