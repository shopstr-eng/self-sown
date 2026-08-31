const verifyNip98RequestMock = jest.fn();
const markMessagesAsReadMock = jest.fn();
const applyRateLimitMock = jest.fn();

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  markMessagesAsRead: (...args: unknown[]) => markMessagesAsReadMock(...args),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

import handler from "@/pages/api/db/mark-messages-read";

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
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

describe("/api/db/mark-messages-read", () => {
  beforeEach(() => {
    verifyNip98RequestMock.mockReset();
    markMessagesAsReadMock.mockReset();
    applyRateLimitMock.mockReset();
    applyRateLimitMock.mockResolvedValue(true);
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "a".repeat(64),
    });
    markMessagesAsReadMock.mockResolvedValue(undefined);
  });

  it("deduplicates bounded gift-wrap IDs for the authenticated seller", async () => {
    const messageId = "1".repeat(64);
    const req = {
      method: "POST",
      body: { messageIds: [messageId, messageId] },
      headers: {},
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "POST", req.body);
    expect(markMessagesAsReadMock).toHaveBeenCalledWith(
      [messageId],
      "a".repeat(64)
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true });
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("reports a database failure instead of claiming messages were read", async () => {
    markMessagesAsReadMock.mockRejectedValueOnce(new Error("database offline"));
    const req = {
      method: "POST",
      body: { messageIds: ["1".repeat(64)] },
      headers: {},
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ error: "Failed to mark messages as read" });
  });

  it.each([
    ["a non-array", "not-an-array", 400],
    ["a non-string ID", [123], 400],
    ["a malformed event ID", ["not-a-gift-wrap-id"], 400],
    [
      "too many IDs",
      Array.from({ length: 201 }, (_, index) =>
        index.toString(16).padStart(64, "0")
      ),
      413,
    ],
  ])("rejects %s", async (_label, messageIds, expectedStatus) => {
    const req = {
      method: "POST",
      body: { messageIds },
      headers: {},
    } as any;
    const res = createResponse();

    await handler(req, res as any);

    expect(res.statusCode).toBe(expectedStatus);
    expect(markMessagesAsReadMock).not.toHaveBeenCalled();
  });
});
