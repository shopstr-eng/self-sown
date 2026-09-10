/** @jest-environment node */

// Guard for the agent.json discovery endpoint (pages/api/.well-known/agent.json.ts).
//
// The handler builds every advertised URL (logo, onboarding, MCP endpoints)
// from the platform origin. It must derive that origin from
// utils/site-url.ts (getSiteUrl) like every other surface, whose fallback is
// the production domain. It previously read NEXT_PUBLIC_BASE_URL itself with
// an "http://localhost:5000" fallback, so a production deploy with the env
// unset/lost would publicly advertise localhost URLs to AI agents — the same
// wrong-origin class of bug discovery-files-site-domain.test.ts guards for
// the static files under public/.

import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/.well-known/agent.json";

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as Record<string, unknown> | undefined,
    headers: {} as Record<string, string | number>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload as Record<string, unknown>;
      return this;
    },
    setHeader(key: string, value: string | number) {
      this.headers[key] = value;
      return this;
    },
  };
}

function callHandler(envBaseUrl: string | undefined) {
  const original = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = envBaseUrl;
  try {
    const res = createResponse();
    handler(
      { method: "GET", headers: {} } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    return res;
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = original;
  }
}

const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>)\]`]+/g;

function advertisedUrls(body: unknown): string[] {
  return JSON.stringify(body).match(ABSOLUTE_URL_RE) ?? [];
}

describe("agent.json discovery endpoint base URL", () => {
  it("never emits localhost/127.0.0.1 URLs, even when NEXT_PUBLIC_BASE_URL is unset", () => {
    const res = callHandler(undefined);
    expect(res.statusCode).toBe(200);
    const urls = advertisedUrls(res.jsonBody);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/localhost/);
      expect(url).not.toMatch(/127\.0\.0\.1/);
      expect(url).not.toMatch(/\[::1\]/);
    }
    // Falls back to the production domain from utils/site-url.ts.
    expect(res.jsonBody?.logo).toBe("https://self-sown.com/milk-market.png");
  });

  it("never emits localhost URLs when NEXT_PUBLIC_BASE_URL is empty", () => {
    const res = callHandler("");
    for (const url of advertisedUrls(res.jsonBody)) {
      expect(url).not.toMatch(/localhost/);
    }
  });

  it("follows NEXT_PUBLIC_BASE_URL when stubbed", () => {
    const res = callHandler("https://cutover.example");
    expect(res.jsonBody?.logo).toBe("https://cutover.example/milk-market.png");
    const endpoints = res.jsonBody?.endpoints as Record<string, string>;
    expect(endpoints.mcp).toBe("https://cutover.example/api/mcp");
    expect(endpoints.manifest).toBe(
      "https://cutover.example/.well-known/agent.json"
    );
    expect(endpoints.onboarding).toBe(
      "https://cutover.example/api/mcp/onboard"
    );
    const onboarding = res.jsonBody?.onboarding as { endpoint: string };
    expect(onboarding.endpoint).toBe("https://cutover.example/api/mcp/onboard");
    const protocols = res.jsonBody?.protocols as {
      mcp: { endpoint: string };
    };
    expect(protocols.mcp.endpoint).toBe("https://cutover.example/api/mcp");
  });
});
