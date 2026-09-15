/** @jest-environment node */

// Handler-level regression for /.well-known/ucp: on a seller custom domain the
// proxy injects x-ss-custom-domain-host and the profile must route the
// platform-only URLs (MCP endpoint, onboarding, OpenAPI spec) at the platform
// SITE_URL, because those paths are blocked on seller domains. A stale header
// name here (e.g. the pre-rename x-mm-*) silently points agents at blocked
// URLs. The proxy strips inbound x-mm-*/x-ss-* headers, so the handler must
// honor ONLY the freshly-injected x-ss- name.

import type { NextApiRequest, NextApiResponse } from "next";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

const resolveHostScope = jest.fn();
const deriveBaseUrl = jest.fn();
jest.mock("@/utils/ucp/seller-host", () => ({
  resolveHostScope: () => resolveHostScope(),
  deriveBaseUrl: () => deriveBaseUrl(),
}));

const isSelfHost = jest.fn(() => false);
jest.mock("@/utils/self-host/config", () => ({
  isSelfHost: () => isSelfHost(),
}));

jest.mock("@/utils/site-url", () => ({
  getSiteUrl: () => "https://self-sown.com",
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require("@/pages/api/.well-known/ucp").default;

const SELLER = {
  pubkey: "ab".repeat(32),
  npub: "npub1example",
  name: "Green Valley Farm",
};

function mockReq(headers: Record<string, string> = {}): NextApiRequest {
  return { method: "GET", headers, socket: {} } as unknown as NextApiRequest;
}

function mockRes() {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    end: jest.fn(),
  };
  return res as unknown as NextApiResponse & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

describe("UCP discovery handler custom-domain routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isSelfHost.mockReturnValue(false);
    deriveBaseUrl.mockReturnValue("https://farm.example");
    resolveHostScope.mockResolvedValue({
      scope: "seller",
      seller: SELLER,
      unresolved: false,
    });
  });

  it("routes platform-only URLs to SITE_URL when the proxy-injected custom-domain header is present", async () => {
    const res = mockRes();
    await handler(mockReq({ "x-ss-custom-domain-host": "farm.example" }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).toContain("https://self-sown.com/api/mcp");
    expect(body).not.toContain("farm.example/api/mcp");
    expect(body).not.toContain("farm.example/api/openapi.json");
  });

  it("keeps platform-only URLs on the request host when no custom-domain header is present", async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).toContain("https://farm.example/api/mcp");
  });

  it("ignores the legacy x-mm- header name (stripped at the proxy boundary)", async () => {
    const res = mockRes();
    await handler(mockReq({ "x-mm-custom-domain-host": "farm.example" }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).toContain("https://farm.example/api/mcp");
    expect(body).not.toContain("https://self-sown.com/api/mcp");
  });
});
