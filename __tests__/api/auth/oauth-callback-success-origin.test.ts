/** @jest-environment node */

// Success-redirect origin pinning: the redirect to /auth/oauth-success carries
// credentials (nsec) in its query string, so its origin must be a verified
// initiating origin — the authorize-time redirect_uri cookie (validated
// same-origin at oauth-redirect time), or, for Apple's cookie-less form_post,
// the provider-registered request host. Never the configured site URL.

import crypto from "crypto";
import handler from "@/pages/api/auth/oauth-callback";
import { SITE_HOST } from "@/utils/site-url";

const queryMock = jest.fn();
jest.mock("pg", () => ({
  Client: jest.fn(() => ({
    connect: jest.fn(),
    query: queryMock,
    end: jest.fn(),
  })),
}));

const APPLE_CLIENT_ID = "com.example.selfsown.web";

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn(),
    setHeader: jest.fn(),
  } as any;
}

function makeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", kid: "KEY1", typ: "JWT" })}.${b64(payload)}.sig`;
}

beforeEach(() => {
  jest.clearAllMocks();
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  process.env.APPLE_CLIENT_ID = APPLE_CLIENT_ID;
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1";
  process.env.APPLE_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.DATABASE_URL = "postgres://test";
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes("SELECT pubkey, encrypted_nsec FROM oauth_auth")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("INSERT INTO oauth_auth")) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  for (const key of [
    "APPLE_CLIENT_ID",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "DATABASE_URL",
  ]) {
    delete process.env[key];
  }
  delete (global as any).fetch;
});

describe("oauth-callback success-redirect origin", () => {
  it("Google: lands on the pinned authorize-time cookie origin, not the request host", async () => {
    const cookieOrigin = "https://shop.custom-domain.example";
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "tok" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: "buyer@example.com", id: "gid-1" }),
      });
    const res = makeRes();
    await handler(
      {
        method: "GET",
        query: { code: "google-code", state: "state-123" },
        body: {},
        cookies: {
          oauth_provider: "google",
          oauth_redirect_uri: `${cookieOrigin}/api/auth/oauth-callback`,
          oauth_state: "state-123",
        },
        headers: {
          host: SITE_HOST,
          "x-forwarded-proto": "https",
          cookie: `oauth_provider=google; oauth_redirect_uri=${cookieOrigin}/api/auth/oauth-callback; oauth_state=state-123`,
        },
      } as any,
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining(`${cookieOrigin}/auth/oauth-success`)
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("nsec=")
    );
  });

  it("Apple (cookie-less form_post): lands on the request host the provider posted back to", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id_token: makeIdToken({
          iss: "https://appleid.apple.com",
          aud: APPLE_CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 600,
          email: "orchard@example.com",
          sub: "apple-sub-0001",
        }),
      }),
    });
    const res = makeRes();
    await handler(
      {
        method: "POST",
        body: { code: "apple-auth-code", state: "state-123" },
        query: {},
        // Cross-site POST drops the Lax provider/redirect cookies; the
        // SameSite=None state cookie survives.
        cookies: { oauth_state: "state-123" },
        headers: { host: SITE_HOST, "x-forwarded-proto": "https" },
      } as any,
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining(`https://${SITE_HOST}/auth/oauth-success`)
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("nsec=")
    );
  });
});
