/** @jest-environment node */

import handler from "@/pages/api/email/unsubscribe";
import { verifySellerEmailUnsubscribeToken } from "@/utils/email/unsubscribe-tokens";
import { unsubscribeSellerEmail } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

jest.mock("@/utils/email/unsubscribe-tokens", () => ({
  verifySellerEmailUnsubscribeToken: jest.fn(),
}));
jest.mock("@/utils/db/db-service", () => ({
  unsubscribeSellerEmail: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

const mocked = {
  verifySellerEmailUnsubscribeToken:
    verifySellerEmailUnsubscribeToken as jest.Mock,
  unsubscribeSellerEmail: unsubscribeSellerEmail as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
};

const PUBKEY = "a".repeat(64);

function createMockResponse() {
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    body: undefined as any,
    headers,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      return response;
    },
    send(payload: unknown) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.applyRateLimit.mockReturnValue(true);
  mocked.verifySellerEmailUnsubscribeToken.mockReturnValue({
    sellerPubkey: PUBKEY,
    email: "buyer@example.com",
  });
  mocked.unsubscribeSellerEmail.mockResolvedValue(true);
});

describe("unsubscribe endpoint (RFC 8058 one-click)", () => {
  test("POST reads the token from the query string and ignores the form body", async () => {
    const req = {
      method: "POST",
      // RFC 8058 one-click POST body — must NOT be treated as the token source.
      body: {
        "List-Unsubscribe": "One-Click",
        token: "BODY-TOKEN-SHOULD-BE-IGNORED",
      },
      query: { token: "QUERY-TOKEN" },
    } as any;
    const res = createMockResponse();
    await handler(req, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ unsubscribed: true });
    // The signed token must come from the query, never the body.
    expect(mocked.verifySellerEmailUnsubscribeToken).toHaveBeenCalledWith(
      "QUERY-TOKEN"
    );
    expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledWith(
      PUBKEY,
      "buyer@example.com"
    );
  });

  test("POST with an invalid query token returns JSON 400", async () => {
    mocked.verifySellerEmailUnsubscribeToken.mockReturnValue(null);
    const req = {
      method: "POST",
      body: { "List-Unsubscribe": "One-Click" },
      query: { token: "bad" },
    } as any;
    const res = createMockResponse();
    await handler(req, res as any);
    expect(res.statusCode).toBe(400);
    expect(mocked.unsubscribeSellerEmail).not.toHaveBeenCalled();
  });

  test("GET returns an HTML confirmation page on success", async () => {
    const req = {
      method: "GET",
      body: {},
      query: { token: "QUERY-TOKEN" },
    } as any;
    const res = createMockResponse();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(String(res.body)).toContain("unsubscribed");
  });

  test("rejects non-GET/POST methods", async () => {
    const req = { method: "DELETE", body: {}, query: {} } as any;
    const res = createMockResponse();
    await handler(req, res as any);
    expect(res.statusCode).toBe(405);
  });
});
