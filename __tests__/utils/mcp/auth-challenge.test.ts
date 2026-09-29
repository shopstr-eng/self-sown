/** @jest-environment node */

// RFC 9728 §5.1 challenge: a 401 from the shared bearer preamble must point
// agents at the protected-resource metadata document via WWW-Authenticate so
// they can discover scopes_supported and self-serve a key. The URL is derived
// from the request Host because the same API answers on seller custom domains
// (where the metadata document carries that host as its `resource`).

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  withSchemaDdlLock: jest.fn(async (_pool: unknown, fn: () => unknown) => fn()),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn(async () => true),
}));

import { authenticateRequest } from "@/utils/mcp/auth";
import { SITE_URL } from "@/utils/site-url";
import type { NextApiRequest, NextApiResponse } from "next";

function invoke(host?: string) {
  const headers: Record<string, string> = {};
  const out = {
    status: null as number | null,
    body: null as any,
  };
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
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
  const req = {
    headers: host ? { host } : {},
  } as unknown as NextApiRequest;
  return (async () => {
    // No Authorization header -> missing-token 401 branch.
    const result = await authenticateRequest(
      req,
      res as unknown as NextApiResponse
    );
    return { ...out, headers, result };
  })();
}

describe("authenticateRequest WWW-Authenticate challenge", () => {
  it("points the 401 at the RFC 9728 metadata on the platform origin", async () => {
    const res = await invoke();
    expect(res.result).toBeNull();
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"`
    );
  });

  it("derives the metadata URL from a seller custom-domain Host", async () => {
    const res = await invoke("greenpastures.farm");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://greenpastures.farm/.well-known/oauth-protected-resource"'
    );
  });
});
