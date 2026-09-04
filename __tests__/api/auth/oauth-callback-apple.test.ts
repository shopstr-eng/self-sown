/** @jest-environment node */

// Apple OAuth callback: the branch added alongside the Google flow. Covers
// env gating, the ES256 client-secret mint (a REAL P-256 key, so crypto.sign
// runs for real), id_token claim validation, and the oauth_auth insert with
// provider "apple".

import crypto from "crypto";
import handler from "@/pages/api/auth/oauth-callback";

const queryMock = jest.fn();
jest.mock("pg", () => ({
  Client: jest.fn(() => ({
    connect: jest.fn(),
    query: queryMock,
    end: jest.fn(),
  })),
}));

const APPLE_CLIENT_ID = "com.example.milkmarket.web";
let applePrivateKeyPem: string;

function makeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", kid: "KEY1", typ: "JWT" })}.${b64(payload)}.sig`;
}

function goodIdToken() {
  return makeIdToken({
    iss: "https://appleid.apple.com",
    aud: APPLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "orchard@example.com",
    sub: "apple-sub-0001",
  });
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn(),
    setHeader: jest.fn(),
  } as any;
}

function makeAppleReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    body: { code: "apple-auth-code", state: "state-123" },
    query: {},
    cookies: {
      oauth_provider: "apple",
      oauth_redirect_uri: "https://milk.market/api/auth/oauth-callback",
      oauth_state: "state-123",
    },
    headers: { host: "milk.market", "x-forwarded-proto": "https" },
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  applePrivateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.APPLE_CLIENT_ID = APPLE_CLIENT_ID;
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1";
  process.env.APPLE_PRIVATE_KEY = applePrivateKeyPem;
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
  delete process.env.APPLE_CLIENT_ID;
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_KEY_ID;
  delete process.env.APPLE_PRIVATE_KEY;
  delete process.env.DATABASE_URL;
  delete (global as any).fetch;
});

describe("oauth-callback (apple)", () => {
  it("redirects to oauth-error when Apple env is not configured", async () => {
    delete process.env.APPLE_TEAM_ID;
    const res = makeRes();
    await handler(makeAppleReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/auth/oauth-error")
    );
  });

  it("mints an ES256 client secret, exchanges the code, and creates a new apple user", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id_token: goodIdToken() }),
    });
    const res = makeRes();
    await handler(makeAppleReq(), res);

    // Token exchange went to Apple with a 3-part JWT client secret.
    expect((global as any).fetch).toHaveBeenCalledWith(
      "https://appleid.apple.com/auth/token",
      expect.objectContaining({ method: "POST" })
    );
    const body = (global as any).fetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("client_id")).toBe(APPLE_CLIENT_ID);
    expect(body.get("code")).toBe("apple-auth-code");
    expect(body.get("redirect_uri")).toBe(
      "https://milk.market/api/auth/oauth-callback"
    );
    const clientSecret = body.get("client_secret")!;
    const [h, p, s] = clientSecret.split(".");
    expect(s).toBeTruthy();
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toMatchObject({
      alg: "ES256",
      kid: "KEY1",
    });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "TEAM123456",
      aud: "https://appleid.apple.com",
      sub: APPLE_CLIENT_ID,
    });
    // ES256 signature verifies against the public key derived from our .p8.
    const pub = crypto.createPublicKey(applePrivateKeyPem);
    const verified = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: pub, dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url")
    );
    expect(verified).toBe(true);

    // New user inserted with provider "apple" and Apple's stable sub.
    const insert = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO oauth_auth")
    );
    expect(insert).toBeTruthy();
    expect(insert![1][0]).toBe("apple");
    expect(insert![1][1]).toBe("apple-sub-0001");
    expect(insert![1][2]).toBe("orchard@example.com");

    // Success redirect mirrors the Google path (provider + isNewUser + email).
    const redirectUrl = res.redirect.mock.calls[0][0] as string;
    expect(redirectUrl).toContain("/auth/oauth-success");
    expect(redirectUrl).toContain("provider=apple");
    expect(redirectUrl).toContain("isNewUser=true");
    expect(redirectUrl).toContain(
      `email=${encodeURIComponent("orchard@example.com")}`
    );
    expect(redirectUrl).toMatch(/nsec=nsec1/);
  });

  it("rejects an id_token whose audience is not our client", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id_token: makeIdToken({
          iss: "https://appleid.apple.com",
          aud: "com.evil.app",
          exp: Math.floor(Date.now() / 1000) + 600,
          email: "orchard@example.com",
          sub: "apple-sub-0001",
        }),
      }),
    });
    const res = makeRes();
    await handler(makeAppleReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/auth/oauth-error")
    );
    const insert = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO oauth_auth")
    );
    expect(insert).toBeUndefined();
  });

  it("redirects to oauth-error when Apple's token endpoint rejects the code", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "invalid_grant" }),
    });
    const res = makeRes();
    await handler(makeAppleReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/auth/oauth-error")
    );
  });

  it("rejects a state mismatch before any token exchange (login CSRF)", async () => {
    (global as any).fetch = jest.fn();
    const res = makeRes();
    await handler(
      makeAppleReq({ body: { code: "apple-auth-code", state: "attacker" } }),
      res
    );
    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/auth/oauth-error")
    );
  });

  it("handles the real Apple form_post shape: only the SameSite=None state cookie survives", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id_token: goodIdToken() }),
    });
    const res = makeRes();
    // Lax cookies (provider, redirect_uri) are omitted on Apple's cross-site
    // POST; provider falls back to POST=apple and redirect_uri is rebuilt.
    await handler(
      makeAppleReq({ cookies: { oauth_state: "state-123" } }),
      res
    );
    const body = (global as any).fetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("redirect_uri")).toBe(
      "https://milk.market/api/auth/oauth-callback"
    );
    const insert = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO oauth_auth")
    );
    expect(insert![1][0]).toBe("apple");
    expect(res.redirect.mock.calls[0][0]).toContain("provider=apple");
  });
});
