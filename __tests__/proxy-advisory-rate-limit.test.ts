/** @jest-environment node */

// Advisory RateLimit headers (proxy.ts withAdvisoryRateLimitHeaders). The
// numeric RateLimit-* budget (600 req/min) is real only where a limiter
// enforces it — API routes and the documented agent surface (agents.txt).
// Plain HTML navigations have no such limiter, so stamping a constant
// "600 of 600 remaining" on every storefront page claimed a budget nothing
// grants or tracks. Navigations must get NO numeric advisory; machine-facing
// responses (API, well-known, agent-negotiated formats) keep it, and routes
// with a real limiter (x-ss-rl-skip marker) are never double-stamped.
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

  it("keeps the documented agent budget on /api/ responses without their own limiter", async () => {
    const proxy = loadProxy();
    const res = await proxy(buildRequest("/api/some-endpoint"));
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
    expect(res.headers.get("RateLimit-Remaining")).toBe("600");
    expect(res.headers.get("RateLimit-Reset")).toBe("60");
    expect(res.headers.get("RateLimit-Policy")).toBe('"agent";q=600;w=60');
  });

  it("keeps the budget on /.well-known/ discovery files", async () => {
    const proxy = loadProxy();
    const res = await proxy(buildRequest("/.well-known/agent.json"));
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
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
