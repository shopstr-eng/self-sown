const markDiscountCodeUsedMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  markDiscountCodeUsed: (...args: unknown[]) =>
    markDiscountCodeUsedMock(...args),
}));

import handler from "@/pages/api/db/discount-code-used";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const seller = "e".repeat(64);

function createRequest(body: unknown) {
  return {
    method: "POST",
    headers: {},
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

describe("/api/db/discount-code-used", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    markDiscountCodeUsedMock.mockReset().mockResolvedValue(undefined);
  });

  it("rejects requests missing fields", async () => {
    const res = createResponse();
    await handler(createRequest({ code: "SAVE10" }), res as any);
    expect(res.statusCode).toBe(400);
    expect(markDiscountCodeUsedMock).not.toHaveBeenCalled();
  });

  it("marks a code used", async () => {
    const res = createResponse();
    await handler(
      createRequest({ code: "SAVE10", pubkey: seller }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(markDiscountCodeUsedMock).toHaveBeenCalledWith("SAVE10", seller);
  });

  it("caps repeated burns of the same code from one IP", async () => {
    let last = createResponse();
    for (let i = 0; i < 11; i++) {
      last = createResponse();
      await handler(
        createRequest({ code: "SAVE10", pubkey: seller }),
        last as any
      );
    }
    expect(last.statusCode).toBe(429);
    // The per-code budget is 10/hour: the 11th burn never reaches the DB.
    expect(markDiscountCodeUsedMock).toHaveBeenCalledTimes(10);
  });

  it("tracks budgets per code, so a different code still works", async () => {
    for (let i = 0; i < 10; i++) {
      await handler(
        createRequest({ code: "SAVE10", pubkey: seller }),
        createResponse() as any
      );
    }
    const res = createResponse();
    await handler(createRequest({ code: "OTHER", pubkey: seller }), res as any);
    expect(res.statusCode).toBe(200);
  });
});
