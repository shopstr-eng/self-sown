/**
 * POST /api/inventory ownership binding: set/sync/restore must verify the
 * target product belongs to the NIP-98-authenticated seller — not merely that
 * the caller controls the sellerPubkey they pass in. Without the product
 * lookup, any signed user could overwrite another seller's stock by id.
 *
 * The buyer-path actions (check/deduct) and GET must stay open.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/inventory/index";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { fetchProductByIdFromDb } from "@/utils/db/db-service";
import {
  setStock,
  restoreStock,
  syncFromNostrEvent,
  deductStock,
  checkAvailability,
} from "@/utils/db/inventory-service";

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: jest.fn(),
}));
jest.mock("@/utils/db/db-service", () => ({
  fetchProductByIdFromDb: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  getStock: jest.fn(),
  getAllStock: jest.fn(),
  setStock: jest.fn(),
  deductStock: jest.fn(),
  restoreStock: jest.fn(),
  checkAvailability: jest.fn(),
  syncFromNostrEvent: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(true),
}));

const mockVerify = verifyNip98Request as jest.Mock;
const mockFetchProduct = fetchProductByIdFromDb as jest.Mock;
const mockSetStock = setStock as jest.Mock;
const mockRestoreStock = restoreStock as jest.Mock;
const mockSync = syncFromNostrEvent as jest.Mock;
const mockDeduct = deductStock as jest.Mock;
const mockCheck = checkAvailability as jest.Mock;

const SELLER = "a".repeat(64);
const OTHER_SELLER = "b".repeat(64);
const PRODUCT_ID = "c".repeat(64);

function createRequest(body: Record<string, unknown>): NextApiRequest {
  return {
    method: "POST",
    query: {},
    body,
    headers: { authorization: "Nostr signed" },
  } as any;
}

function createResponse() {
  const res: any = { statusCode: 200, body: undefined as unknown };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res as NextApiResponse & { body: Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue({ ok: true, pubkey: SELLER });
  // Default: the product exists and belongs to the authenticated seller.
  mockFetchProduct.mockResolvedValue({ id: PRODUCT_ID, pubkey: SELLER });
  mockSetStock.mockResolvedValue({ quantity: 5 });
  mockRestoreStock.mockResolvedValue({ success: true });
  mockSync.mockResolvedValue(undefined);
  mockDeduct.mockResolvedValue({ success: true });
  mockCheck.mockResolvedValue({ available: true });
});

describe("set", () => {
  const body = {
    action: "set",
    productId: PRODUCT_ID,
    sellerPubkey: SELLER,
    quantity: 5,
  };

  it("401s without a valid NIP-98 proof", async () => {
    mockVerify.mockResolvedValue({ ok: false, error: "bad signature" });
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(401);
    expect(mockSetStock).not.toHaveBeenCalled();
  });

  it("403s when the passed sellerPubkey is not the signer's", async () => {
    const res = createResponse();
    await handler(createRequest({ ...body, sellerPubkey: OTHER_SELLER }), res);
    expect(res.statusCode).toBe(403);
    expect(mockSetStock).not.toHaveBeenCalled();
  });

  it("403s when the product belongs to another seller", async () => {
    mockFetchProduct.mockResolvedValue({
      id: PRODUCT_ID,
      pubkey: OTHER_SELLER,
    });
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(403);
    expect(mockSetStock).not.toHaveBeenCalled();
  });

  it("404s when the product is not mirrored server-side", async () => {
    mockFetchProduct.mockResolvedValue(null);
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(404);
    expect(mockSetStock).not.toHaveBeenCalled();
  });

  it("sets stock when the signer owns the product", async () => {
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(200);
    expect(mockSetStock).toHaveBeenCalledWith(
      PRODUCT_ID,
      SELLER,
      5,
      undefined,
      "seller_override"
    );
  });
});

describe("sync", () => {
  const body = {
    action: "sync",
    productId: PRODUCT_ID,
    sellerPubkey: SELLER,
    globalQuantity: 10,
  };

  it("403s when the product belongs to another seller", async () => {
    mockFetchProduct.mockResolvedValue({
      id: PRODUCT_ID,
      pubkey: OTHER_SELLER,
    });
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(403);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("syncs when the signer owns the product", async () => {
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(200);
    expect(mockSync).toHaveBeenCalledWith(PRODUCT_ID, SELLER, 10, undefined);
  });
});

describe("restore", () => {
  const body = {
    action: "restore",
    productId: PRODUCT_ID,
    sellerPubkey: SELLER,
    amount: 2,
    orderId: "order-1",
  };

  it("403s when the product belongs to another seller", async () => {
    mockFetchProduct.mockResolvedValue({
      id: PRODUCT_ID,
      pubkey: OTHER_SELLER,
    });
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(403);
    expect(mockRestoreStock).not.toHaveBeenCalled();
  });

  it("restores when the signer owns the product", async () => {
    const res = createResponse();
    await handler(createRequest(body), res);
    expect(res.statusCode).toBe(200);
    expect(mockRestoreStock).toHaveBeenCalledWith(
      PRODUCT_ID,
      2,
      "order-1",
      undefined
    );
  });
});

describe("buyer paths stay open", () => {
  it("deduct does not require a signature", async () => {
    const res = createResponse();
    await handler(
      createRequest({
        action: "deduct",
        productId: PRODUCT_ID,
        amount: 1,
        orderId: "order-9",
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockDeduct).toHaveBeenCalled();
  });

  it("check does not require a signature", async () => {
    const res = createResponse();
    await handler(
      createRequest({ action: "check", productId: PRODUCT_ID, quantity: 1 }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockCheck).toHaveBeenCalled();
  });
});
