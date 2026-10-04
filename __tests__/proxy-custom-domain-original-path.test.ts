/** @jest-environment node */

// Custom-domain rewrites must ALWAYS stamp the visitor's public pathname into
// the x-ss-original-path request header. pages/stall/* and
// components/dynamic-meta-head.tsx read it to emit canonical/og:url tags that
// point at the seller's domain instead of the internal /stall/<slug> rewrite
// target; DynamicHead fails safe to the bare domain root when the header is
// missing, so a rewrite branch that forgets it silently collapses every social
// preview and search canonical on that path to "/" — subpages lose their
// distinct URL and nothing errors. This suite exercises every custom-domain
// branch that serves a page render and asserts the header is set to the
// request's public path.
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

const ORIGINAL_PATH_OVERRIDE = "x-middleware-request-x-ss-original-path";

function originalPath(res: Response): string | null {
  return res.headers.get(ORIGINAL_PATH_OVERRIDE);
}

describe("custom-domain rewrites stamp x-ss-original-path", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;
  const HOST = "farm.example";
  const SLUG = "green-valley";
  const PUBKEY = "ab".repeat(32);

  beforeEach(() => {
    lookupByHost.mockClear();
    lookupByHost.mockResolvedValue({ slug: SLUG, pubkey: PUBKEY });
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("root → stall homepage rewrite forwards '/'", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(HOST, "/", { accept: "text/html" })
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      `/stall/${SLUG}`
    );
    expect(originalPath(res)).toBe("/");
  });

  it("generic subpage rewrite forwards the public subpage path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/shop", "/blog/why-local-food"]) {
      const res = await proxy(
        buildRequest(HOST, path, { accept: "text/html" })
      );
      expect(res.headers.get("x-middleware-rewrite")).toContain(
        `/stall/${SLUG}${path}`
      );
      expect(originalPath(res)).toBe(path);
    }
  });

  it("homepage agent content-negotiation rewrite forwards '/'", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(HOST, "/", { accept: "text/markdown" })
    );
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

  it("allow-listed API passthrough forwards the public path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/api/db/fetch-products"));
    expect(res.status).not.toBe(403);
    expect(originalPath(res)).toBe("/api/db/fetch-products");
  });

  it("already-prefixed /stall/<slug> paths forward the public path", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, `/stall/${SLUG}/shop`));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(originalPath(res)).toBe(`/stall/${SLUG}/shop`);
  });

  it("no-slug fallback rewrite still forwards the public path", async () => {
    lookupByHost.mockResolvedValue({ slug: null, pubkey: null });
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/about"));
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/stall/_custom-domain"
    );
    expect(originalPath(res)).toBe("/about");
  });

  it("blocked API branch is a proxy-generated 403, not a header-bearing rewrite", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/api/mcp"));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
