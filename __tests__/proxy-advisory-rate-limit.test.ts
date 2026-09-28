/** @jest-environment node */

// Advisory RateLimit headers (proxy.ts withAdvisoryRateLimitHeaders). The
// numeric RateLimit-* budget (600 req/min) is real only where a limiter
// enforces it: /api/mcp + /api/mcp/status (agents.txt's documented agent
// surface). Plain HTML navigations and every other API/well-known route have
// no such limiter, so stamping a constant "600 of 600 remaining" on them
// claimed a budget nothing grants or tracks. Only /api/mcp* paths keep the
// advisory; routes with a real limiter (x-ss-rl-skip marker or their own
// RateLimit-* headers) are never double-stamped.
//
// NEXT_PUBLIC_BASE_URL is captured at module import time, so it is stubbed
// and proxy re-required inside jest.isolateModules (same pattern as
// proxy-legacy-host.test.ts).

import { NextRequest } from "next/server";

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: null, pubkey: null })),
}));

function loadProxy(): typeof import("@/proxy").proxy {
  process.env.NEXT_PUBLIC_BASE_URL = "https://self-sown.com";
  let proxyFn: typeof import("@/proxy").proxy | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    proxyFn = require("@/proxy").proxy;
  });
  return proxyFn!;
}

function buildRequest(
  path: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`https://self-sown.com${path}`, {
    headers: { host: "self-sown.com", ...headers },
  });
}

describe("advisory RateLimit headers", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("stamps NO numeric rate-limit budget on plain HTML navigations", async () => {
    const proxy = loadProxy();
    const res = await proxy(
      buildRequest("/about", {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0",
      })
    );
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
    expect(res.headers.get("RateLimit-Remaining")).toBeNull();
    expect(res.headers.get("RateLimit-Reset")).toBeNull();
    expect(res.headers.get("RateLimit-Policy")).toBeNull();
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("stamps no budget on navigations with a default */* accept either", async () => {
    const proxy = loadProxy();
    const res = await proxy(buildRequest("/stall/some-store"));
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("keeps the documented agent budget on /api/mcp paths", async () => {
    const proxy = loadProxy();
    for (const path of ["/api/mcp", "/api/mcp/status"]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBe("600");
      expect(res.headers.get("RateLimit-Remaining")).toBe("600");
      expect(res.headers.get("RateLimit-Reset")).toBe("60");
      expect(res.headers.get("RateLimit-Policy")).toBe('"agent";q=600;w=60');
    }
  });

  it("stamps NO budget on other /api/ routes without their own limiter", async () => {
    const proxy = loadProxy();
    // No 600/60s limiter enforces anything on arbitrary API routes, so the
    // advisory must not claim one. Routes with their own (different) limiter
    // stamp their own accurate headers via applyRateLimit.
    for (const path of ["/api/some-endpoint", "/api/db/fetch-products"]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Remaining")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
  });

  it("stamps NO 600 budget on /api/mcp/* siblings with their own tighter limits", async () => {
    const proxy = loadProxy();
    // Onboard enforces 10/hour (and stamps its own headers via
    // reportRateLimit); api-keys 30/min, create-order 60/min, etc. The
    // proxy must never stamp the 600/60s advisory on these paths — least of
    // all on their 429s.
    for (const path of [
      "/api/mcp/onboard",
      "/api/mcp/api-keys",
      "/api/mcp/create-order",
      "/api/mcp/verify-payment",
      "/api/mcp/set-nsec",
    ]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
    }
  });

  it("stamps NO budget on /.well-known/ files without their own limiter", async () => {
    const proxy = loadProxy();
    // agent.json has no limiter; the UCP + signature-directory routes enforce
    // their own 600/60s and stamp their own headers (or opt out via the skip
    // marker), so the proxy adds nothing either way.
    const res = await proxy(buildRequest("/.well-known/agent.json"));
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("stamps NO budget on the custom-domain /api/mcp rejection", async () => {
    const proxy = loadProxy();
    // /api/mcp is not in the custom-domain API allowlist, so the proxy 403s
    // it there without any limiter running — the response must not inherit
    // the platform's documented budget.
    const res = await proxy(
      buildRequest("/api/mcp", { host: "shop.farmer.example" })
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("leaves agent-negotiated page formats to their real upstream limiter", async () => {
    const proxy = loadProxy();
    // /about with a markdown Accept rewrites to /api/agent-view, which
    // enforces its own per-agent budget — the proxy must not stamp the
    // advisory over (or alongside) those accurate headers.
    const res = await proxy(buildRequest("/about", { accept: "text/markdown" }));
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("leaves known LLM agent user agents to their real upstream limiter", async () => {
    const proxy = loadProxy();
    // ClaudeBot on a stall page rewrites to stall-agent-view (rate-limited).
    const res = await proxy(
      buildRequest("/stall/some-store", { "user-agent": "ClaudeBot/1.0" })
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("stamps no budget when an LLM bot gets the HTML page (no agent-view rewrite)", async () => {
    const proxy = loadProxy();
    // /listing/<product> has no agent-view rewrite: even a recognized LLM
    // crawler falls through to the HTML product page, which no 600/60s
    // limiter covers — the advisory must not claim one.
    const headerCases: Record<string, string>[] = [
      { "user-agent": "ClaudeBot/1.0" },
      { accept: "text/markdown" },
      { accept: "application/json", "user-agent": "GPTBot/1.0" },
    ];
    for (const headers of headerCases) {
      const res = await proxy(buildRequest("/listing/abc123", headers));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Remaining")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
  });

  it("strips the skip marker and adds nothing where a route opts out (real limiter upstream)", async () => {
    const proxy = loadProxy();
    // The Web Bot Auth directory route sets x-ss-rl-skip itself.
    const res = await proxy(
      buildRequest("/.well-known/http-message-signatures-directory")
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });
});
