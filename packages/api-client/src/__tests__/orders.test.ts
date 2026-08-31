import { SellerOrdersApiError, createSellerOrdersApiClient } from "../index";

const sellerPubkey = "a".repeat(64);
const wrapId = "1".repeat(64);
const proofEvent = {
  id: "2".repeat(64),
  pubkey: sellerPubkey,
  created_at: 1_750_000_000,
  kind: 27_235,
  tags: [],
  content: "",
  sig: "3".repeat(128),
};

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function getRequest(fetchImpl: jest.Mock) {
  const call = fetchImpl.mock.calls[0] as [string, RequestInit];
  return {
    url: call[0],
    init: call[1],
    headers: call[1].headers as Headers,
  };
}

describe("seller orders api client", () => {
  it("fetches seller-addressed cached messages with the signed proof header", async () => {
    const message = {
      id: wrapId,
      pubkey: "b".repeat(64),
      created_at: 1_750_000_000,
      kind: 1059,
      tags: [["p", sellerPubkey]],
      content: "encrypted",
      sig: "c".repeat(128),
      is_read: false,
    };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([message]));
    const client = createSellerOrdersApiClient({
      baseUrl: "http://127.0.0.1:5000/",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.fetchSellerMessages({ sellerPubkey, signedEvent: proofEvent })
    ).resolves.toEqual({ messages: [message], rejectedMessageCount: 0 });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe(
      `http://127.0.0.1:5000/api/db/fetch-messages?pubkey=${sellerPubkey}`
    );
    expect(request.init.method).toBe("GET");
    expect(request.headers.get("x-signed-event")).toBe(
      JSON.stringify(proofEvent)
    );
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.init.body).toBeUndefined();
  });

  it("isolates malformed cached messages without discarding valid envelopes", async () => {
    const validMessage = {
      id: wrapId,
      pubkey: "b".repeat(64),
      created_at: 1_750_000_000,
      kind: 1059,
      tags: [["p", sellerPubkey]],
      content: "encrypted",
      sig: "c".repeat(128),
      is_read: false,
    };
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse([validMessage, { id: wrapId, content: "malformed" }])
      );
    const client = createSellerOrdersApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.fetchSellerMessages({ sellerPubkey, signedEvent: proofEvent })
    ).resolves.toEqual({
      messages: [validMessage],
      rejectedMessageCount: 1,
    });
  });

  it("posts deduplicated bounded order IDs and validates statuses", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        statuses: {
          "order-1": "confirmed",
          "order-2": "shipped",
        },
      })
    );
    const client = createSellerOrdersApiClient({
      baseUrl: "http://localhost:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.fetchOrderStatuses({
        orderIds: ["order-1", " order-2 ", "order-1"],
        authorizationHeader: "Nostr signed-authorization",
      })
    ).resolves.toEqual({
      "order-1": "confirmed",
      "order-2": "shipped",
    });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe("http://localhost:5000/api/db/get-order-statuses");
    expect(request.init.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Authorization")).toBe(
      "Nostr signed-authorization"
    );
    expect(request.init.body).toBe(
      JSON.stringify({ orderIds: ["order-1", "order-2"] })
    );
  });

  it("marks only bounded gift-wrap IDs read with NIP-98 authorization", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = createSellerOrdersApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.markMessagesRead({
        messageIds: [wrapId, wrapId],
        authorizationHeader: "Nostr signed-authorization",
      })
    ).resolves.toEqual({ success: true });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe("/api/db/mark-messages-read");
    expect(request.init.method).toBe("POST");
    expect(request.headers.get("Authorization")).toBe(
      "Nostr signed-authorization"
    );
    expect(request.init.body).toBe(JSON.stringify({ messageIds: [wrapId] }));
  });

  it("persists a validated seller status with NIP-98 authorization", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        orderId: "order-123",
        status: "shipped",
        persisted: true,
        version: 2,
      })
    );
    const client = createSellerOrdersApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.updateOrderStatus({
        orderId: "order-123",
        sellerPubkey: "a".repeat(64),
        buyerPubkey: "b".repeat(64),
        expectedStatus: "confirmed",
        status: "shipped",
        messageId: wrapId,
        transitionId: "2".repeat(64),
        authorizationHeader: "Nostr signed-authorization",
      })
    ).resolves.toEqual({
      success: true,
      orderId: "order-123",
      status: "shipped",
      persisted: true,
      version: 2,
    });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe("/api/db/update-order-status");
    expect(request.init.body).toBe(
      JSON.stringify({
        orderId: "order-123",
        sellerPubkey: "a".repeat(64),
        buyerPubkey: "b".repeat(64),
        expectedStatus: "confirmed",
        status: "shipped",
        messageId: wrapId,
        transitionId: "2".repeat(64),
      })
    );
    expect(request.headers.get("Authorization")).toBe(
      "Nostr signed-authorization"
    );
  });

  it.each([
    [
      "invalid seller key",
      () => ({ sellerPubkey: "bad", signedEvent: proofEvent }),
    ],
    [
      "too many order IDs",
      () => Array.from({ length: 201 }, (_, index) => `order-${index}`),
    ],
    ["oversized order ID", () => ["x".repeat(129)]],
    ["invalid gift-wrap ID", () => ["not-a-wrap-id"]],
  ])("rejects %s before making a request", async (label, inputFactory) => {
    const fetchImpl = jest.fn();
    const client = createSellerOrdersApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    const operation =
      label === "invalid seller key"
        ? client.fetchSellerMessages(
            inputFactory() as {
              sellerPubkey: string;
              signedEvent: unknown;
            }
          )
        : label === "invalid gift-wrap ID"
          ? client.markMessagesRead({
              messageIds: inputFactory() as string[],
              authorizationHeader: "Nostr signed-authorization",
            })
          : client.fetchOrderStatuses({
              orderIds: inputFactory() as string[],
              authorizationHeader: "Nostr signed-authorization",
            });

    await expect(operation).rejects.toMatchObject({
      name: "SellerOrdersApiError",
      code: "INVALID_REQUEST",
      status: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a safe typed error without copying credentials or request data", async () => {
    const secret = "Nostr extremely-sensitive-authorization";
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: "You are not allowed to update this order." },
          403
        )
      );
    const client = createSellerOrdersApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.updateOrderStatus({
        orderId: "order-secret-123",
        sellerPubkey: "a".repeat(64),
        buyerPubkey: "b".repeat(64),
        expectedStatus: "pending",
        status: "confirmed",
        messageId: wrapId,
        transitionId: "2".repeat(64),
        authorizationHeader: secret,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SellerOrdersApiError);
    const error = caught as SellerOrdersApiError;
    expect(error).toMatchObject({
      status: 403,
      code: "REQUEST_FAILED",
      message: "You are not allowed to update this order.",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("order-secret-123");
  });
});
