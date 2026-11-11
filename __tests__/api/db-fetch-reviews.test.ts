/** @jest-environment node */

jest.mock("@/utils/db/db-service", () => ({
  fetchReviewsByAddressesFromDb: jest.fn(),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

import handler from "@/pages/api/db/fetch-reviews";
import { fetchReviewsByAddressesFromDb } from "@/utils/db/db-service";

const mFetch = fetchReviewsByAddressesFromDb as jest.Mock;

function mockRes() {
  const r: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
    setHeader() {},
    getHeader() {},
  };
  return r;
}

function mockReq(method: string, body?: any) {
  return { method, body: body ?? {} } as any;
}

const addressA =
  "30402:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:product-a";
const addressB =
  "30405:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:product-b";

beforeEach(() => {
  jest.clearAllMocks();
  mFetch.mockResolvedValue([]);
});

describe("pages/api/db/fetch-reviews", () => {
  it("rejects non-POST methods", async () => {
    const res = mockRes();
    await handler(mockReq("GET"), res);
    expect(res.statusCode).toBe(405);
    expect(mFetch).not.toHaveBeenCalled();
  });

  it("returns an empty list without querying when addresses are missing or empty", async () => {
    for (const body of [{}, { addresses: null }, { addresses: [] }]) {
      const res = mockRes();
      await handler(mockReq("POST", body), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([]);
    }
    expect(mFetch).not.toHaveBeenCalled();
  });

  it("passes the product addresses through to the SQL-filtered lookup", async () => {
    const review = {
      id: "id1",
      pubkey: "pk1",
      created_at: 123,
      kind: 31555,
      tags: [["d", addressA]],
      content: "great",
      sig: "sig1",
    };
    mFetch.mockResolvedValue([review]);

    const res = mockRes();
    await handler(mockReq("POST", { addresses: [addressA, addressB] }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([review]);
    expect(mFetch).toHaveBeenCalledWith([addressA, addressB]);
  });

  it("rejects oversized or malformed address sets", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `${addressA}-${i}`);
    const res1 = mockRes();
    await handler(mockReq("POST", { addresses: tooMany }), res1);
    expect(res1.statusCode).toBe(400);

    const res2 = mockRes();
    await handler(
      mockReq("POST", { addresses: [addressA, "x".repeat(513)] }),
      res2
    );
    expect(res2.statusCode).toBe(400);

    const res3 = mockRes();
    await handler(mockReq("POST", { addresses: [addressA, 42] }), res3);
    expect(res3.statusCode).toBe(400);

    expect(mFetch).not.toHaveBeenCalled();
  });

  it("surfaces a 500 when the database lookup fails", async () => {
    mFetch.mockRejectedValue(new Error("db down"));
    const res = mockRes();
    await handler(mockReq("POST", { addresses: [addressA] }), res);
    expect(res.statusCode).toBe(500);
  });
});
