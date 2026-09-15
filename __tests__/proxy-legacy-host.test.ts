/** @jest-environment node */

// Legacy base-domain routing (proxy.ts). milk.market is retired as the base
// domain but still owned and pointing at this deployment: page traffic 301s
// to the canonical host (path + query preserved, so previously-sent email
// deep links with 90-day click TTLs keep working), while /api/ and
// /.well-known/ traffic is exempt and keeps being served as platform traffic
// — webhook senders (Stripe) treat 3xx as delivery failure and
// verification/discovery files must stay reachable on the old domain. The
// legacy host must never be treated as a seller custom domain (which would
// render the "Domain Not Configured" placeholder for old links).
//
// SITE_HOST/SITE_URL are captured at module import time, so the env var is
// stubbed and proxy re-required inside jest.isolateModules.

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

describe("legacy-domain redirect routing", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("301s apex page traffic to the canonical host, preserving path + query", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("milk.market", "/listing/abc123", "review_token=xyz")
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      "https://self-sown.com/listing/abc123?review_token=xyz"
    );
  });

  it("301s www and arbitrary subdomains of the legacy domain too", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const host of ["www.milk.market", "acme.milk.market"]) {
      const res = await proxy(buildRequest(host, "/about"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://self-sown.com/about");
    }
  });

  it("builds the redirect destination from the canonical origin, not the request URL", async () => {
    const proxy = loadProxy("https://self-sown.com");
    // http:// request must still land on the canonical https origin.
    const res = await proxy(
      new NextRequest("http://milk.market/about", {
        headers: { host: "milk.market" },
      })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });

  it("does not redirect when the legacy domain IS the configured base (pre-cutover safety)", async () => {
    const proxy = loadProxy("https://milk.market");
    const res = await proxy(buildRequest("milk.market", "/about"));
    expect(res.status).not.toBe(301);
  });

  it("keeps serving /api/ on the legacy domain (webhook senders treat 3xx as delivery failure)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("milk.market", "/api/stripe/webhook"));
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
    // Exempt traffic must fall through as platform traffic, never into
    // custom-domain routing.
    expect(res.headers.get("x-middleware-rewrite") || "").not.toContain(
      "_custom-domain"
    );
  });

  it("keeps serving /.well-known/ on the legacy domain (verification/discovery files)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("milk.market", "/.well-known/nostr.json")
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite") || "").not.toContain(
      "_custom-domain"
    );
  });

  it("301s port-bearing legacy hosts (Host: milk.market:443 must not bypass)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      new NextRequest("https://milk.market:443/about", {
        headers: { host: "milk.market:443" },
      })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });

  it("still 301s www.<canonical> to the apex", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("www.self-sown.com", "/about"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });
});
