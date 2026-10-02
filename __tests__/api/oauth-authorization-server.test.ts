/** @jest-environment node */

// RFC 8414 authorization-server metadata + WorkOS auth.md agent_auth block.
// The scanner finding this guards: capability metadata must describe a REAL,
// working flow — issuer and every endpoint are host-derived (same rule as
// the RFC 9728 PRM), and the full identity -> token -> revoke round trip is
// exercised here against the actual handlers with only the DB mocked.

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

const createApiKeyMock = jest.fn();
const revokeApiKeyMock = jest.fn();
const validateApiKeyMock = jest.fn();
jest.mock("@/utils/mcp/auth", () => ({
  initializeApiKeysTable: jest.fn(async () => undefined),
  createApiKey: (...args: any[]) => createApiKeyMock(...args),
  revokeApiKey: (...args: any[]) => revokeApiKeyMock(...args),
  validateApiKey: (...args: any[]) => validateApiKeyMock(...args),
}));

import metadataHandler from "@/pages/api/.well-known/oauth-authorization-server";
import prmHandler from "@/pages/api/.well-known/oauth-protected-resource";
import identityHandler from "@/pages/api/agent/identity";
import tokenHandler from "@/pages/api/oauth2/token";
import revokeHandler from "@/pages/api/oauth2/revoke";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

function makeRes() {
  const out = {
    status: null as number | null,
    body: null as any,
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: any) {
      out.body = payload;
      return this;
    },
  };
  return { res, out };
}

async function invoke(
  handler: any,
  method: string,
  body?: any,
  headers: Record<string, string> = {}
) {
  const { res, out } = makeRes();
  await handler(
    { method, headers, body } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return out;
}

describe("/.well-known/oauth-authorization-server", () => {
  it("serves RFC 8414 metadata with the auth.md agent_auth block", async () => {
    const out = await invoke(metadataHandler, "GET", undefined, {
      host: "self-sown.com",
    });
    expect(out.status).toBe(200);
    expect(out.body.issuer).toBe("https://self-sown.com");
    expect(out.body.token_endpoint).toBe(
      "https://self-sown.com/api/oauth2/token"
    );
    expect(out.body.revocation_endpoint).toBe(
      "https://self-sown.com/api/oauth2/revoke"
    );
    expect(out.body.grant_types_supported).toEqual([
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);
    expect(out.body.agent_auth.skill).toBe("https://self-sown.com/auth.md");
    expect(out.body.agent_auth.identity_endpoint).toBe(
      "https://self-sown.com/api/agent/identity"
    );
    // Only identity types we actually verify — no identity_assertion/ID-JAG.
    expect(out.body.agent_auth.identity_types_supported).toEqual([
      "anonymous",
      "service_auth",
    ]);
    expect(out.headers["cache-control"]).toContain("public");
  });

  it("derives issuer and endpoints from the request Host (custom domain)", async () => {
    const out = await invoke(metadataHandler, "GET", undefined, {
      host: "greenpastures.farm",
    });
    expect(out.body.issuer).toBe("https://greenpastures.farm");
    expect(out.body.token_endpoint).toBe(
      "https://greenpastures.farm/api/oauth2/token"
    );
    expect(out.body.agent_auth.skill).toBe(
      "https://greenpastures.farm/auth.md"
    );
  });

  it("rejects non-GET methods with 405", async () => {
    const out = await invoke(metadataHandler, "POST", undefined, {
      host: "self-sown.com",
    });
    expect(out.status).toBe(405);
  });
});

describe("PRM -> AS cross-link", () => {
  it("authorization_servers points at the same host-derived origin", async () => {
    const out = await invoke(prmHandler, "GET", undefined, {
      host: "greenpastures.farm",
    });
    expect(out.body.authorization_servers).toEqual([
      "https://greenpastures.farm",
    ]);
  });
});

describe("agent-auth flow (identity -> token -> revoke)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createApiKeyMock.mockResolvedValue({
      key: "ss_testkey123",
      record: { id: 42, pubkey: "ab".repeat(32) },
    });
    validateApiKeyMock.mockResolvedValue({ id: 42, pubkey: "ab".repeat(32) });
    revokeApiKeyMock.mockResolvedValue(true);
  });

  it("anonymous identity -> jwt-bearer exchange yields a working key", async () => {
    const identity = await invoke(
      identityHandler,
      "POST",
      { type: "anonymous", name: "test-agent" },
      { host: "self-sown.com" }
    );
    expect(identity.status).toBe(200);
    expect(identity.body.identity_assertion.split(".")).toHaveLength(3);
    expect(identity.body.pubkey).toMatch(/^[0-9a-f]{64}$/);

    const token = await invoke(
      tokenHandler,
      "POST",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: identity.body.identity_assertion,
      },
      { host: "self-sown.com" }
    );
    expect(token.status).toBe(200);
    expect(token.body.access_token).toBe("ss_testkey123");
    expect(token.body.token_type).toBe("Bearer");
    // The exchange mints a REAL shopping key through the shared createApiKey.
    expect(createApiKeyMock).toHaveBeenCalledWith(
      "test-agent",
      identity.body.pubkey,
      "read",
      undefined,
      "shopping"
    );

    const revoke = await invoke(
      revokeHandler,
      "POST",
      { token: "ss_testkey123" },
      { host: "self-sown.com" }
    );
    expect(revoke.status).toBe(200);
    expect(revokeApiKeyMock).toHaveBeenCalledWith(42, "ab".repeat(32));
  });

  it("rejects a tampered assertion with RFC 6749 invalid_grant", async () => {
    const identity = await invoke(
      identityHandler,
      "POST",
      { type: "anonymous" },
      { host: "self-sown.com" }
    );
    const [h, p] = identity.body.identity_assertion.split(".");
    const tampered = `${h}.${p}.${Buffer.from("forged").toString("base64url")}`;
    const token = await invoke(
      tokenHandler,
      "POST",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: tampered,
      },
      { host: "self-sown.com" }
    );
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported grant type", async () => {
    const token = await invoke(
      tokenHandler,
      "POST",
      { grant_type: "client_credentials" },
      { host: "self-sown.com" }
    );
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("unsupported_grant_type");
  });

  it("service_auth without a signed proof fails closed", async () => {
    const identity = await invoke(
      identityHandler,
      "POST",
      { type: "service_auth", pubkey: "ab".repeat(32) },
      { host: "self-sown.com" }
    );
    expect(identity.status).toBe(401);
  });

  it("revoke returns 200 for an unknown token (no validity oracle)", async () => {
    validateApiKeyMock.mockResolvedValue(null);
    const out = await invoke(
      revokeHandler,
      "POST",
      { token: "ss_nonexistent" },
      { host: "self-sown.com" }
    );
    expect(out.status).toBe(200);
    expect(revokeApiKeyMock).not.toHaveBeenCalled();
  });
});
