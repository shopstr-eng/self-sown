/** @jest-environment node */

// Legacy base-domain cutover routing (proxy.ts). After NEXT_PUBLIC_BASE_URL
// flips to the new canonical host, page traffic on the legacy domain (and any
// of its subdomains) must 301 to SITE_HOST with path + query preserved so
// previously-sent email deep links (order confirmations, HMAC-signed
// review/unsubscribe links with 90-day click TTLs) keep working. /api/ and
// /.well-known/ traffic must NOT redirect: webhook senders (Stripe) treat 3xx
// as delivery failure, and verification/discovery files must stay reachable
// on the old domain during the transition window.
//
// SITE_HOST/LEGACY_SITE_HOST are captured at module import time, so each
// scenario stubs the env var and re-requires proxy inside
// jest.isolateModules.

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

describe("legacy-domain redirect (post-cutover)", () => {
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

  it("301s www and arbitrary subdomains of the legacy domain", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const www = await proxy(buildRequest("www.milk.market", "/about"));
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe("https://self-sown.com/about");
    const sub = await proxy(buildRequest("acme.milk.market", "/"));
    expect(sub.status).toBe(301);
    expect(sub.headers.get("location")).toBe("https://self-sown.com/");
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

  it("redirects port-bearing legacy hosts (Host: milk.market:443)", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      new NextRequest("https://milk.market:443/about", {
        headers: { host: "milk.market:443" },
      })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });

  it("redirects http:// legacy requests to the canonical https origin", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      new NextRequest("http://milk.market/about", {
        headers: { host: "milk.market" },
      })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://self-sown.com/about");
  });

  it("honors a configured non-default canonical origin (protocol + port)", async () => {
    const proxy = loadProxy("http://localhost:5000");
    const res = await proxy(buildRequest("milk.market", "/about"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://localhost:5000/about");
  });

  it("301s OAuth callback pages — the state-pinned redirect URI keeps the token exchange valid", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/square-oauth-redirect", "/shippo-oauth-redirect"]) {
      const res = await proxy(
        buildRequest("milk.market", path, "code=abc&state=xyz")
      );
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `https://self-sown.com${path}?code=abc&state=xyz`
      );
    }
  });

  it("does NOT redirect the legacy domain before the cutover (env still on the old domain)", async () => {
    const proxy = loadProxy("https://milk.market");
    const res = await proxy(buildRequest("milk.market", "/about"));
    expect(res.headers.get("location")).toBeNull();
  });
});
