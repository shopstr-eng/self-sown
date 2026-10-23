const verifyNip98RequestMock = jest.fn();
const queryMock = jest.fn();
const connectMock = jest.fn();
const endMock = jest.fn();

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: connectMock,
    query: queryMock,
    end: endMock,
  })),
}));

import handler from "@/pages/api/utm-analytics";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const adminPubkey = "c".repeat(64);
const stranger = "d".repeat(64);

function createRequest(authed = true) {
  return {
    method: "GET",
    headers: authed ? { authorization: "Nostr signed-proof" } : {},
    socket: { remoteAddress: "127.0.0.1" },
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

describe("/api/utm-analytics", () => {
  const savedAdmins = process.env.ADMIN_PUBKEYS;

  beforeEach(() => {
    __resetRateLimitBuckets();
    jest.clearAllMocks();
    process.env.ADMIN_PUBKEYS = adminPubkey;
    queryMock.mockResolvedValue({ rows: [{ count: "3" }] });
  });

  afterAll(() => {
    process.env.ADMIN_PUBKEYS = savedAdmins;
  });

  it("rejects unauthenticated requests", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: false,
      error: "Missing NIP-98 authorization header",
    });
    const res = createResponse();
    await handler(createRequest(false), res as any);
    expect(res.statusCode).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-admins", async () => {
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: stranger });
    const res = createResponse();
    await handler(createRequest(), res as any);
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns analytics to an admin", async () => {
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: adminPubkey });
    const res = createResponse();
    await handler(createRequest(), res as any);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as any).totalVisits).toBe(3);
    expect(queryMock).toHaveBeenCalled();
  });
});
