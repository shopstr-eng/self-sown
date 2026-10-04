/** @jest-environment node */

// Self-host (single-tenant) rewrites must ALWAYS stamp the visitor's public
// pathname into the x-ss-original-path request header, exactly like the
// custom-domain block (see __tests__/proxy-custom-domain-original-path.test.ts).
// routeSelfHost mirrors that block with its own buildHeaders helper, so a
// regression here would not be caught by the custom-domain suite: pages/stall/*
// and components/dynamic-meta-head.tsx read the header to emit canonical/og:url
// tags that point at the seller's own domain instead of the internal
// /stall/<slug> rewrite target; DynamicHead fails safe to the bare domain root
// when the header is missing, so a rewrite branch that forgets it silently
// collapses every social preview and search canonical on that path to "/" —
// subpages lose their distinct URL and nothing errors. This suite exercises
// every routeSelfHost branch that serves a page render and asserts the header
// is set to the request's public path.
//
// Next encodes request-header overrides on the response as
// `x-middleware-request-<name>` entries, so the tests assert on those.
//
// SS_SELF_HOST / SS_SELF_HOST_SLUG are read per-request, but
// NEXT_PUBLIC_BASE_URL is captured at module import time, so the env vars are
// stubbed and proxy re-required inside jest.isolateModules.

import { NextRequest } from "next/server";

// Self-host mode never hits the per-host lookup (slug/pubkey come from the
// environment), but the import chain pulls the cache module in — mock it so the
// suite never touches a DB pool.
jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: null, pubkey: null })),
}));

const SELF_HOST_ENV = [
  "SS_SELF_HOST",
  "SS_SELF_HOST_SLUG",
  "SS_SELF_HOST_PUBKEY",
] as const;

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

const ORIGINAL_PATH_OVERRIDE = "x-middleware-request-x-ss-original-path";

function originalPath(res: Response): string | null {
  return res.headers.get(ORIGINAL_PATH_OVERRIDE);
}

describe("self-host rewrites stamp x-ss-original-path", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const HOST = "shop.myownfarm.test";
  const SLUG = "green-valley";
  const PUBKEY = "ab".repeat(32);

  beforeEach(() => {
    for (const key of [...SELF_HOST_ENV, "NEXT_PUBLIC_BASE_URL"]) {
      ORIGINAL_ENV[key] = process.env[key];
    }
    process.env.SS_SELF_HOST = "1";
    process.env.SS_SELF_HOST_SLUG = SLUG;
    process.env.SS_SELF_HOST_PUBKEY = PUBKEY;
  });

  afterEach(() => {
    for (const key of Object.keys(ORIGINAL_ENV)) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it("root → stall homepage rewrite forwards '/'", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/", { accept: "text/html" }));
    expect(res.headers.get("x-middleware-rewrite")).toContain(`/stall/${SLUG}`);
    expect(originalPath(res)).toBe("/");
  });

  it("generic subpage rewrite forwards the public subpage path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/shop", "/blog/why-local-food"]) {
      const res = await proxy(buildRequest(HOST, path, { accept: "text/html" }));
      expect(res.headers.get("x-middleware-rewrite")).toContain(
        `/stall/${SLUG}${path}`
      );
      expect(originalPath(res)).toBe(path);
    }
  });

  it("homepage agent content-negotiation rewrite forwards '/'", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/", { accept: "text/markdown" }));
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/api/stall-agent-view"
    );
    expect(originalPath(res)).toBe("/");
  });

  it("blog-post agent content-negotiation rewrite forwards the post path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(HOST, "/blog/harvest-notes", {
        accept: "application/json",
      })
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/api/stall-agent-view"
    );
    expect(originalPath(res)).toBe("/blog/harvest-notes");
  });

  it("per-stall GEO/agent file rewrites forward the file path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/llms.txt", "/sitemap.xml", "/rss.xml"]) {
      const res = await proxy(buildRequest(HOST, path));
      expect(res.headers.get("x-middleware-rewrite")).toContain(
        "/api/stall-agent-view"
      );
      expect(originalPath(res)).toBe(path);
    }
  });

  it("per-seller NIP-05 nostr.json rewrite forwards the well-known path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/.well-known/nostr.json"));
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/api/storefront/nostr-json"
    );
    expect(originalPath(res)).toBe("/.well-known/nostr.json");
  });

  it("UCP discovery rewrite forwards the well-known path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/.well-known/ucp"));
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/api/.well-known/ucp"
    );
    expect(originalPath(res)).toBe("/.well-known/ucp");
  });

  it("platform passthrough pages forward their public path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/cart", "/listing/abc123"]) {
      const res = await proxy(buildRequest(HOST, path));
      // Passthrough (no rewrite), but the header must still ride along for
      // any canonical/og:url these pages emit.
      expect(originalPath(res)).toBe(path);
    }
  });

  it("allowed API passthrough forwards the public path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/api/db/fetch-products"));
    expect(res.status).not.toBe(404);
    expect(originalPath(res)).toBe("/api/db/fetch-products");
  });

  it("already-prefixed /stall/<slug> paths forward the public path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, `/stall/${SLUG}/shop`));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(originalPath(res)).toBe(`/stall/${SLUG}/shop`);
  });

  it("self-host hides platform pages with a redirect, not a header-bearing rewrite", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/marketplace"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://${HOST}/`);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("blocked API branch is a proxy-generated 404, not a header-bearing passthrough", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of [
      "/api/pro/create-subscription",
      "/api/stripe/connect/accounts",
    ]) {
      const res = await proxy(buildRequest(HOST, path));
      expect(res.status).toBe(404);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("self-host enabled without a slug fails closed with a 503", async () => {
    delete process.env.SS_SELF_HOST_SLUG;
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/"));
    expect(res.status).toBe(503);
  });
});
