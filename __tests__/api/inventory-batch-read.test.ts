/**
 * GET /api/inventory?productIds=a,b,c — the batch read behind live stock on
 * cards and listing pages. It is public (stock is already visible on the
 * storefront) but must be bounded: capped id count, validated ids, rate
 * limited, never cached, and the single-product GET must keep working.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/inventory/index";
import { getAllStock, getStockForProducts } from "@/utils/db/inventory-service";
import { applyRateLimit } from "@/utils/rate-limit";

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: jest.fn(),
}));
jest.mock("@/utils/db/db-service", () => ({
  fetchProductByIdFromDb: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  getStock: jest.fn(),
  getAllStock: jest.fn(),
  getStockForProducts: jest.fn(),
  setStock: jest.fn(),
  deductStock: jest.fn(),
  restoreStock: jest.fn(),
  checkAvailability: jest.fn(),
  syncFromNostrEvent: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(),
}));

const mockBatch = getStockForProducts as jest.Mock;
const mockAll = getAllStock as jest.Mock;
const mockRateLimit = applyRateLimit as jest.Mock;

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function createRequest(query: Record<string, unknown>): NextApiRequest {
  return { method: "GET", query, headers: {} } as any;
}

function createResponse() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
  };
  return res as NextApiResponse & {
    body: Record<string, any>;
    headers: Record<string, string>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRateLimit.mockResolvedValue(true);
  mockBatch.mockResolvedValue(new Map());
});

describe("GET /api/inventory?productIds=", () => {
  test("returns a snapshot per tracked product and omits untracked ones", async () => {
    mockBatch.mockResolvedValue(
      new Map([
        [
          ID_A,
          {
            default_quantity: 3,
            variants: {},
            default_updated_at: 1_700_000_000,
          },
        ],
      ])
    );
    const res = createResponse();
    await handler(createRequest({ productIds: `${ID_A},${ID_B}` }), res);

    expect(res.statusCode).toBe(200);
    expect(mockBatch).toHaveBeenCalledWith([ID_A, ID_B]);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.stock)).toEqual([ID_A]);
    expect(res.body.stock[ID_A].default_quantity).toBe(3);
  });

  test("is never cached", async () => {
    const res = createResponse();
    await handler(createRequest({ productIds: ID_A }), res);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  test("trims and dedupes ids before querying", async () => {
    const res = createResponse();
    await handler(
      createRequest({ productIds: ` ${ID_A}, ${ID_A} ,,${ID_B}` }),
      res
    );
    expect(mockBatch).toHaveBeenCalledWith([ID_A, ID_B]);
  });

  test("rejects an empty list", async () => {
    const res = createResponse();
    await handler(createRequest({ productIds: " , " }), res);
    expect(res.statusCode).toBe(400);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  test("rejects a repeated query parameter", async () => {
    const res = createResponse();
    await handler(createRequest({ productIds: [ID_A, ID_B] }), res);
    expect(res.statusCode).toBe(400);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  test("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(",");
    const res = createResponse();
    await handler(createRequest({ productIds: ids }), res);
    expect(res.statusCode).toBe(400);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  test("accepts exactly 100 ids", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`).join(",");
    const res = createResponse();
    await handler(createRequest({ productIds: ids }), res);
    expect(res.statusCode).toBe(200);
  });

  test.each(["bad id", "x;drop", "a".repeat(129), "é"])(
    "rejects the invalid id %p",
    async (bad) => {
      const res = createResponse();
      await handler(createRequest({ productIds: `${ID_A},${bad}` }), res);
      expect(res.statusCode).toBe(400);
      expect(mockBatch).not.toHaveBeenCalled();
    }
  );

  test("stops when the rate limiter rejects the request", async () => {
    mockRateLimit.mockResolvedValue(false);
    const res = createResponse();
    await handler(createRequest({ productIds: ID_A }), res);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  test("returns 500 without leaking details when the query fails", async () => {
    mockBatch.mockRejectedValue(new Error("connection refused 10.0.0.5"));
    const res = createResponse();
    await handler(createRequest({ productIds: ID_A }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  test("the single-product GET still works and skips the batch path", async () => {
    mockAll.mockResolvedValue({ default_quantity: 2, variants: {} });
    const res = createResponse();
    await handler(createRequest({ productId: ID_A }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.default_quantity).toBe(2);
    expect(mockBatch).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});
