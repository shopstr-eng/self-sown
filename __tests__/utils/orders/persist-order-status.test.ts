/** @jest-environment node */

import { persistSellerOrderStatusThrough } from "@/utils/orders/persist-order-status";

const sellerPubkey = "a".repeat(64);
const buyerPubkey = "b".repeat(64);
const sourceMessageId = "1".repeat(64);

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe("persistSellerOrderStatusThrough", () => {
  it("persists each lifecycle edge instead of skipping from pending to shipped", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(200, { status: "confirmed" }))
      .mockResolvedValueOnce(response(200, { status: "shipped" }));
    const signer = {
      sign: jest.fn(async (event) => ({
        ...event,
        id: "2".repeat(64),
        pubkey: sellerPubkey,
        sig: "3".repeat(128),
      })),
    } as any;

    await persistSellerOrderStatusThrough({
      signer,
      origin: "https://milk.market",
      orderId: "order-123",
      sellerPubkey,
      buyerPubkey,
      sourceMessageId,
      currentStatus: "pending",
      targetStatus: "shipped",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toMatchObject(
      {
        expectedStatus: "pending",
        status: "confirmed",
        transitionId: `${sourceMessageId}:confirmed`,
      }
    );
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string)).toMatchObject(
      {
        expectedStatus: "confirmed",
        status: "shipped",
        transitionId: `${sourceMessageId}:shipped`,
      }
    );
  });

  it("continues safely when a stale client learns the canonical status", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(409, { currentStatus: "confirmed" }))
      .mockResolvedValueOnce(response(200, { status: "shipped" }));

    await persistSellerOrderStatusThrough({
      signer: { sign: jest.fn(async (event) => event) } as any,
      origin: "https://milk.market",
      orderId: "order-123",
      sellerPubkey,
      buyerPubkey,
      sourceMessageId,
      currentStatus: "pending",
      targetStatus: "shipped",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string)).toMatchObject(
      {
        expectedStatus: "confirmed",
        status: "shipped",
      }
    );
  });

  it("never walks a canceled order forward", async () => {
    const fetchImpl = jest.fn();

    await persistSellerOrderStatusThrough({
      signer: { sign: jest.fn(async (event) => event) } as any,
      origin: "https://milk.market",
      orderId: "order-123",
      sellerPubkey,
      buyerPubkey,
      sourceMessageId,
      currentStatus: "canceled",
      targetStatus: "shipped",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
