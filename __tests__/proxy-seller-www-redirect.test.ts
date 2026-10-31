/** @jest-environment node */

// www.<seller-custom-domain> must not hit the "Domain Not Configured"
// placeholder. The www variant is never in the custom-domain lookup table, so
// proxy.ts 301s it to the bare domain — but ONLY when the bare host resolves
// via lookupByHost (the lookup API answers only for verified, active custom
// domains), mirroring the platform www→apex rule and the stall→custom-domain
// redirect's verified-and-active gate. An unmapped www variant (or a
// transient lookup failure, which also yields slug=null) must fail open to
// the existing placeholder path, never redirect on a guess.
//
// NEXT_PUBLIC_BASE_URL is captured at module import time, so the env var is
// stubbed and proxy re-required inside jest.isolateModules.

import { NextRequest } from "next/server";
import type { HostResolution } from "@/utils/storefront/host-cache";

const lookupByHost = jest.fn(
  async (_origin: string, _host: string): Promise<HostResolution> => ({
    slug: null,
    pubkey: null,
  })
);

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: (origin: string, host: string) => lookupByHost(origin, host),
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

describe("www variant of a seller custom domain", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;
  const BARE = "farm.example";
  const WWW = `www.${BARE}`;
  const SLUG = "green-valley";
  const PUBKEY = "ab".repeat(32);

  beforeEach(() => {
    lookupByHost.mockClear();
    lookupByHost.mockResolvedValue({ slug: null, pubkey: null });
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  // The www variant itself is never in the lookup table, so tests resolve the
  // BARE host as requested and leave the www host unmapped — matching what
  // the real lookup API returns. (A blanket mock would make the www host look
  // independently REGISTERED, which deliberately wins over canonicalization.)
  function mockBareOnly(resolution: {
    slug: string | null;
    pubkey: string | null;
    tlsActive?: boolean;
  }) {
    lookupByHost.mockImplementation(async (_origin: string, host: string) =>
      host === BARE ? resolution : { slug: null, pubkey: null }
    );
  }

  const MAPPED_LIVE = { slug: SLUG, pubkey: PUBKEY, tlsActive: true };

  it("301s a mapped www seller domain to the bare domain, preserving path + query", async () => {
    mockBareOnly(MAPPED_LIVE);
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(WWW, "/shop?sort=new", { accept: "text/html" })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      `https://${BARE}/shop?sort=new`
    );
    // The lookup must resolve the BARE host — the www variant is never in
    // the custom-domain table.
    expect(lookupByHost).toHaveBeenCalledWith(expect.anything(), BARE);
  });

  it("301s the www root to the bare-domain root", async () => {
    mockBareOnly(MAPPED_LIVE);
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "/"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${BARE}/`);
  });

  it("redirects a port-bearing www Host header (www.<domain>:443 can't bypass)", async () => {
    mockBareOnly(MAPPED_LIVE);
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(WWW, "/blog/harvest-notes", { host: `${WWW}:443` })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      `https://${BARE}/blog/harvest-notes`
    );
  });

  it("a '//attacker.example' path can never turn the 301 into an arbitrary-destination redirect", async () => {
    mockBareOnly(MAPPED_LIVE);
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "//attacker.example/steal"));
    expect(res.status).toBe(301);
    const location = res.headers.get("location");
    // The authority must stay the verified bare host; the double-slash input
    // is carried as a PATH, never reparsed as a new authority.
    expect(location).toBe(`https://${BARE}//attacker.example/steal`);
    expect(location).not.toContain("https://attacker.example");
  });

  it("does NOT redirect while the bare domain's TLS certificate is still pending", async () => {
    // Verified + mapped, but tls_status not yet "active" — redirecting would
    // bounce buyers onto a TLS error, so this fails open to the placeholder
    // (mirrors resolveLiveSellerCustomDomainUrl's gate for the platform-stall
    // redirect).
    mockBareOnly({ slug: SLUG, pubkey: PUBKEY, tlsActive: false });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/_custom-domain"
    );
  });

  it("treats a missing tlsActive flag (older lookup API) as not active", async () => {
    mockBareOnly({ slug: SLUG, pubkey: PUBKEY });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/_custom-domain"
    );
  });

  it("does NOT redirect an unmapped www seller domain — falls through to the placeholder", async () => {
    // lookupByHost resolves slug=null (unverified / unmapped / lapsed).
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "/about"));
    expect(res.status).not.toBe(301);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/_custom-domain"
    );
  });

  it("does NOT redirect when the lookup fails transiently (fail open)", async () => {
    // Transient failure surfaces as slug=null from lookupByHost — same
    // fail-open path as an unmapped domain.
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(WWW, "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/_custom-domain"
    );
  });

  it("leaves the bare seller domain untouched (no redirect loop)", async () => {
    lookupByHost.mockResolvedValue({ slug: SLUG, pubkey: PUBKEY });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(BARE, "/", { accept: "text/html" })
    );
    expect(res.status).not.toBe(301);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      `/stall/${SLUG}`
    );
  });

  it("platform www→apex rule still wins on the platform host", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest("www.self-sown.com", "/marketplace"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      "https://self-sown.com/marketplace"
    );
    // The platform rule fires before any seller-domain lookup.
    expect(lookupByHost).not.toHaveBeenCalled();
  });

  it("a seller whose registered domain literally starts with www. still resolves when the bare host is unmapped", async () => {
    // Bare host unmapped → no redirect; the normal branch then looks up the
    // full www host and serves the storefront.
    lookupByHost.mockImplementation(async (_origin: string, host: string) =>
      host === WWW ? { slug: SLUG, pubkey: PUBKEY } : { slug: null, pubkey: null }
    );
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(WWW, "/", { accept: "text/html" })
    );
    expect(res.status).not.toBe(301);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      `/stall/${SLUG}`
    );
  });

  it("an independently registered www host wins over canonicalization, even when the bare host is also mapped", async () => {
    // BOTH hosts mapped — potentially to different sellers. The explicit www
    // registration must be served, never permanently redirected to the apex
    // storefront.
    const WWW_SLUG = "www-sellers-own-stall";
    lookupByHost.mockImplementation(async (_origin: string, host: string) => {
      if (host === WWW)
        return { slug: WWW_SLUG, pubkey: PUBKEY, tlsActive: true };
      if (host === BARE)
        return { slug: SLUG, pubkey: PUBKEY, tlsActive: true };
      return { slug: null, pubkey: null };
    });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(WWW, "/", { accept: "text/html" })
    );
    expect(res.status).not.toBe(301);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      `/stall/${WWW_SLUG}`
    );
  });
});
