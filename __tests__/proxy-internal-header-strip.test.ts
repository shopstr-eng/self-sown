/** @jest-environment node */

// Internal x-ss-* (legacy x-mm-*) headers are set authoritatively by proxy.ts
// on custom-domain/self-host paths and consumed by _app.tsx, nostr-json,
// seller-host, etc. Because fallthrough routes forward request headers
// unchanged, the proxy must strip inbound copies so a direct caller cannot
// forge custom-domain/self-host context on platform-host requests.
//
// Next encodes request-header overrides on the response as
// `x-middleware-request-<name>` entries, so the tests assert on those.
//
// SITE_HOST/SITE_URL are captured at module import time, so the env var is
// stubbed and proxy re-required inside jest.isolateModules.

import { NextRequest } from "next/server";

const lookupByHost = jest.fn(async () => ({
  slug: null as string | null,
  pubkey: null as string | null,
}));

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: () => lookupByHost(),
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

function buildRequest(
  host: string,
  path: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host, ...headers },
  });
}

describe("internal header trust boundary", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    lookupByHost.mockClear();
    lookupByHost.mockResolvedValue({ slug: null, pubkey: null });
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("strips forged x-ss-* headers from platform-host page traffic", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("self-sown.com", "/about", {
        "x-ss-custom-domain": "1",
        "x-ss-custom-domain-host": "evil.example",
        "x-ss-shop-pubkey": "ab".repeat(32),
        "x-ss-self-host": "1",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-ss-custom-domain")).toBeNull();
    expect(
      res.headers.get("x-middleware-request-x-ss-custom-domain-host")
    ).toBeNull();
    expect(res.headers.get("x-middleware-request-x-ss-shop-pubkey")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-ss-self-host")).toBeNull();
  });

  it("strips forged legacy x-mm-* headers too", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("self-sown.com", "/about", {
        "x-mm-custom-domain-host": "evil.example",
        "x-mm-shop-slug": "some-stall",
      })
    );
    expect(res.status).toBe(200);
    expect(
      res.headers.get("x-middleware-request-x-mm-custom-domain-host")
    ).toBeNull();
    expect(res.headers.get("x-middleware-request-x-mm-shop-slug")).toBeNull();
  });

  it("strips forged internal headers from platform-host UCP discovery", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("self-sown.com", "/.well-known/ucp", {
        "x-ss-custom-domain-host": "evil.example",
      })
    );
    expect(
      res.headers.get("x-middleware-request-x-ss-custom-domain-host")
    ).toBeNull();
  });

  it("custom-domain paths overwrite a forged host header with the authoritative hostname", async () => {
    lookupByHost.mockResolvedValue({ slug: "green-valley", pubkey: null });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("farm.example", "/about", {
        "x-ss-custom-domain-host": "evil.example",
      })
    );
    expect(
      res.headers.get("x-middleware-request-x-ss-custom-domain-host")
    ).toBe("farm.example");
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/green-valley/about"
    );
  });

  it("strips forged internal headers from the Apple Pay verification rewrite", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(
        "self-sown.com",
        "/.well-known/apple-developer-merchantid-domain-association",
        { "x-ss-custom-domain-host": "evil.example" }
      )
    );
    expect(
      res.headers.get("x-middleware-request-x-ss-custom-domain-host")
    ).toBeNull();
  });

  it("preserves ordinary request headers while stripping internal ones", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest("self-sown.com", "/about", {
        "accept-language": "en-US",
        "x-ss-shop-slug": "forged",
      })
    );
    expect(res.headers.get("x-middleware-request-accept-language")).toBe(
      "en-US"
    );
    expect(res.headers.get("x-middleware-request-x-ss-shop-slug")).toBeNull();
  });
});
