/** @jest-environment node */

// Retired base-domain routing (proxy.ts). The milk.market → self-sown.com
// cutover originally 301'd legacy page traffic; once legacy traffic faded the
// redirect scaffolding was retired. The domain is still owned and points at
// this deployment, so it stays in PLATFORM_HOST_SUFFIXES and must be served
// as ordinary PLATFORM traffic — never redirected, and never treated as a
// seller custom domain (which would render the "Domain Not Configured"
// placeholder for old links).
//
// SITE_HOST is captured at module import time, so the env var is stubbed and
// proxy re-required inside jest.isolateModules.

import { NextRequest } from "next/server";

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: null, pubkey: null })),
}));

function loadProxy(siteUrl: string): typeof import("@/proxy").proxy {
  process.env.NEXT_PUBLIC_BASE_URL = siteUrl;
  let proxyFn: typeof import("@/proxy").proxy | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    proxyFn = require("@/proxy").proxy;
  });
  return proxyFn!;
}

function buildRequest(host: string, path: string, query = ""): NextRequest {
  const url = `https://${host}${path}${query ? `?${query}` : ""}`;
  return new NextRequest(url, { headers: { host } });
}

describe("legacy-domain platform routing (redirect retired)", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("serves apex page traffic directly — no 301 to the canonical host", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("milk.market", "/listing/abc123", "review_token=xyz")
    );
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });

  it("serves www and arbitrary subdomains of the legacy domain as platform traffic", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const host of ["www.milk.market", "acme.milk.market"]) {
      const res = await proxy(buildRequest(host, "/about"));
      expect(res.headers.get("location")).toBeNull();
      // Not treated as a seller custom domain: no rewrite to the
      // "Domain Not Configured" placeholder.
      expect(res.headers.get("x-middleware-rewrite") || "").not.toContain(
        "_custom-domain"
      );
    }
  });

  it("never rewrites legacy page traffic to the custom-domain placeholder", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("milk.market", "/"));
    expect(res.headers.get("x-middleware-rewrite") || "").not.toContain(
      "_custom-domain"
    );
  });

  it("keeps serving /api/ on the legacy domain (webhook senders treat 3xx as delivery failure)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("milk.market", "/api/stripe/webhook"));
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps serving /.well-known/ on the legacy domain (verification/discovery files)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("milk.market", "/.well-known/nostr.json")
    );
    expect(res.headers.get("location")).toBeNull();
  });

  it("treats port-bearing legacy hosts (Host: milk.market:443) as platform traffic", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      new NextRequest("https://milk.market:443/about", {
        headers: { host: "milk.market:443" },
      })
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite") || "").not.toContain(
      "_custom-domain"
    );
  });

  it("still 301s www.<canonical> to the apex", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("www.self-sown.com", "/about"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });
});
