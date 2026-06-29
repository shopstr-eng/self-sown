/** @jest-environment node */

// Routing-layer coverage for the OTHER agent-facing surfaces proxy.ts
// negotiates besides the single blog post (covered in
// blog-post-negotiation.test.ts):
//
//   1. The stall HOMEPAGE — served as tailored markdown/JSON/plain-text for
//      agents (Accept header or known LLM UA) but kept as the HTML storefront
//      for browsers and HTML-only social/SEO bots.
//   2. The per-stall GEO/agent FILES in STALL_GEO_DYNAMIC_FORMAT
//      (/llms.txt, /robots.txt, /sitemap.xml, /rss.xml, /feed.xml) — served as
//      the seller's tailored feed/sitemap regardless of Accept (explicit file
//      paths). The custom-domain branch must fall THROUGH to the platform's
//      static /public copies when no seller slug resolves for the host.
//   3. The per-seller /.well-known/nostr.json (custom domain) and
//      /.well-known/ucp discovery profile.
//
// Each surface is duplicated across the three host branches (platform host,
// custom domain, self-host), so each branch is exercised. The harness mirrors
// blog-post-negotiation.test.ts: build a real NextRequest, call proxy(), and
// assert on the x-middleware-rewrite + x-middleware-request-* headers.

import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { proxy } from "@/proxy";
import { lookupByHost } from "@/utils/storefront/host-cache";

// The custom-domain branch resolves the seller slug/pubkey for the request host
// via lookupByHost (DB/cache backed). Stub it so the routing test is hermetic;
// individual tests override the resolution to exercise the no-slug / has-pubkey
// paths.
jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: "acme", pubkey: null })),
}));

const mockLookup = lookupByHost as jest.Mock;

const AGENT_UA = "GPTBot/1.0";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TWITTERBOT_UA = "Twitterbot/1.0";
// A 64-char hex pubkey for the per-seller nostr.json path (any truthy value
// satisfies the proxy's `if (!pubkey)` gate; the endpoint validates the rest).
const PUBKEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

beforeEach(() => {
  mockLookup.mockResolvedValue({ slug: "acme", pubkey: null });
});

// Build a real NextRequest the proxy can route.
function buildRequest(
  host: string,
  path: string,
  {
    accept = "",
    ua = "",
    query = "",
  }: { accept?: string; ua?: string; query?: string } = {}
): NextRequest {
  const url = `https://${host}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = { host };
  if (accept) headers.accept = accept;
  if (ua) headers["user-agent"] = ua;
  return new NextRequest(url, { headers });
}

// Decode the routing decision from the middleware response headers.
function inspect(res: NextResponse) {
  const rewriteRaw = res.headers.get("x-middleware-rewrite");
  const rewrite = rewriteRaw ? new URL(rewriteRaw) : null;
  return {
    rewritePath: rewrite?.pathname ?? null,
    rewriteParams: rewrite?.searchParams ?? null,
    fellThrough: res.headers.get("x-middleware-next") === "1",
    requestHeader: (name: string) =>
      res.headers.get(`x-middleware-request-${name}`),
  };
}

// Assert the request was handed off to the stall agent view with the slug +
// negotiated format wired through both query AND request header.
function expectStallAgentView(
  res: NextResponse,
  { slug, format }: { slug: string; format: string }
) {
  const r = inspect(res);
  expect(r.rewritePath).toBe("/api/stall-agent-view");
  expect(r.rewriteParams?.get("slug")).toBe(slug);
  expect(r.rewriteParams?.get("format")).toBe(format);
  expect(r.requestHeader("x-stall-slug")).toBe(slug);
  expect(r.requestHeader("x-stall-format")).toBe(format);
}

// Assert the request was NOT diverted to the machine view — it keeps rendering
// the HTML storefront (falling through or rewritten to the HTML stall page,
// never to /api/stall-agent-view).
function expectHtmlStorefront(res: NextResponse) {
  const r = inspect(res);
  expect(r.rewritePath).not.toBe("/api/stall-agent-view");
}

// --- Stall homepage content negotiation -------------------------------------

describe("proxy() stall homepage negotiation — platform host /stall/<slug>", () => {
  const HOST = "milk.market";
  const PATH = "/stall/acme";

  it("rewrites an LLM crawler to the agent view (markdown)", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: AGENT_UA }));
    expectStallAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit JSON Accept header to the agent view (json)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "application/json", ua: BROWSER_UA })
    );
    expectStallAgentView(res, { slug: "acme", format: "json" });
  });

  it("rewrites a text/plain-only Accept header to the agent view (txt)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/plain", ua: BROWSER_UA })
    );
    expectStallAgentView(res, { slug: "acme", format: "txt" });
  });

  it("keeps a normal browser on the HTML storefront", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlStorefront(res);
  });

  it("keeps an HTML-only social bot on the HTML storefront", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlStorefront(res);
  });
});

describe("proxy() stall homepage negotiation — custom domain /", () => {
  const HOST = "farmer.example";
  const PATH = "/";

  it("rewrites an LLM crawler to the agent view (markdown)", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: AGENT_UA }));
    expectStallAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit markdown Accept header to the agent view (markdown)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/markdown", ua: BROWSER_UA })
    );
    expectStallAgentView(res, { slug: "acme", format: "md" });
  });

  it("keeps a normal browser on the HTML storefront", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlStorefront(res);
  });

  it("keeps an HTML-only social bot on the HTML storefront", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlStorefront(res);
  });
});

describe("proxy() stall homepage negotiation — self-host /", () => {
  const HOST = "myfarm.example";
  const PATH = "/";

  let prevEnabled: string | undefined;
  let prevSlug: string | undefined;

  beforeEach(() => {
    prevEnabled = process.env.MM_SELF_HOST;
    prevSlug = process.env.MM_SELF_HOST_SLUG;
    process.env.MM_SELF_HOST = "1";
    process.env.MM_SELF_HOST_SLUG = "acme";
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.MM_SELF_HOST;
    else process.env.MM_SELF_HOST = prevEnabled;
    if (prevSlug === undefined) delete process.env.MM_SELF_HOST_SLUG;
    else process.env.MM_SELF_HOST_SLUG = prevSlug;
  });

  it("rewrites an LLM crawler to the agent view (markdown)", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: AGENT_UA }));
    expectStallAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit JSON Accept header to the agent view (json)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "application/json", ua: BROWSER_UA })
    );
    expectStallAgentView(res, { slug: "acme", format: "json" });
  });

  it("keeps a normal browser on the HTML storefront", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlStorefront(res);
  });

  it("keeps an HTML-only social bot on the HTML storefront", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlStorefront(res);
  });
});

// --- Per-stall GEO / agent files (STALL_GEO_DYNAMIC_FORMAT) ------------------

// All five logical files and the stall-agent-view `format` each maps to. The
// custom-domain and self-host branches serve every entry from the seller's
// root; the platform host only serves the explicit /stall/<slug>/<file> feeds
// (rss/feed/sitemap) — llms.txt/robots.txt fall through to static /public.
const GEO_FILES: Array<[string, string]> = [
  ["/llms.txt", "llms"],
  ["/robots.txt", "robots"],
  ["/sitemap.xml", "sitemap"],
  ["/rss.xml", "rss"],
  ["/feed.xml", "rss"],
];

describe("proxy() GEO files — platform host /stall/<slug>/<file>", () => {
  const HOST = "milk.market";

  // The platform host only dynamically serves the per-stall feeds + sitemap;
  // these are routed regardless of Accept (explicit file paths).
  const PLATFORM_GEO: Array<[string, string]> = [
    ["rss.xml", "rss"],
    ["feed.xml", "rss"],
    ["sitemap.xml", "sitemap"],
  ];

  it.each(PLATFORM_GEO)(
    "rewrites /stall/acme/%s to the agent view (%s) even for a browser",
    async (file, format) => {
      const res = await proxy(
        buildRequest(HOST, `/stall/acme/${file}`, {
          accept: "text/html",
          ua: BROWSER_UA,
        })
      );
      expectStallAgentView(res, { slug: "acme", format });
    }
  );
});

describe("proxy() GEO files — custom domain root /<file>", () => {
  const HOST = "farmer.example";

  it.each(GEO_FILES)(
    "rewrites %s to the agent view (%s)",
    async (path, format) => {
      const res = await proxy(
        buildRequest(HOST, path, { accept: "text/html", ua: BROWSER_UA })
      );
      expectStallAgentView(res, { slug: "acme", format });
    }
  );

  it.each(GEO_FILES)(
    "falls through to the static /public copy when no slug resolves (%s)",
    async (path) => {
      mockLookup.mockResolvedValue({ slug: null, pubkey: null });
      const res = await proxy(
        buildRequest(HOST, path, { accept: "text/html", ua: BROWSER_UA })
      );
      const r = inspect(res);
      expect(r.rewritePath).not.toBe("/api/stall-agent-view");
      expect(r.fellThrough).toBe(true);
    }
  );
});

describe("proxy() GEO files — self-host root /<file>", () => {
  const HOST = "myfarm.example";

  let prevEnabled: string | undefined;
  let prevSlug: string | undefined;

  beforeEach(() => {
    prevEnabled = process.env.MM_SELF_HOST;
    prevSlug = process.env.MM_SELF_HOST_SLUG;
    process.env.MM_SELF_HOST = "1";
    process.env.MM_SELF_HOST_SLUG = "acme";
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.MM_SELF_HOST;
    else process.env.MM_SELF_HOST = prevEnabled;
    if (prevSlug === undefined) delete process.env.MM_SELF_HOST_SLUG;
    else process.env.MM_SELF_HOST_SLUG = prevSlug;
  });

  it.each(GEO_FILES)(
    "rewrites %s to the agent view (%s)",
    async (path, format) => {
      const res = await proxy(
        buildRequest(HOST, path, { accept: "text/html", ua: BROWSER_UA })
      );
      expectStallAgentView(res, { slug: "acme", format });
    }
  );
});

// --- Per-seller /.well-known/nostr.json + /.well-known/ucp ------------------

describe("proxy() /.well-known/nostr.json — custom domain", () => {
  const HOST = "farmer.example";
  const PATH = "/.well-known/nostr.json";

  it("rewrites to the per-seller nostr-json endpoint when a pubkey resolves", async () => {
    mockLookup.mockResolvedValue({ slug: "acme", pubkey: PUBKEY });
    const res = await proxy(buildRequest(HOST, PATH));
    const r = inspect(res);
    expect(r.rewritePath).toBe("/api/storefront/nostr-json");
    expect(r.requestHeader("x-mm-shop-pubkey")).toBe(PUBKEY);
  });

  it("falls through to the static /public copy when no pubkey resolves", async () => {
    mockLookup.mockResolvedValue({ slug: "acme", pubkey: null });
    const res = await proxy(buildRequest(HOST, PATH));
    const r = inspect(res);
    expect(r.rewritePath).not.toBe("/api/storefront/nostr-json");
    expect(r.fellThrough).toBe(true);
  });
});

describe("proxy() /.well-known/ucp discovery profile", () => {
  const PATH = "/.well-known/ucp";

  it("rewrites to the aggregate UCP endpoint on the platform host", async () => {
    const res = await proxy(buildRequest("milk.market", PATH));
    expect(inspect(res).rewritePath).toBe("/api/.well-known/ucp");
  });

  it("rewrites to the seller-scoped UCP endpoint on a custom domain", async () => {
    const res = await proxy(buildRequest("farmer.example", PATH));
    const r = inspect(res);
    expect(r.rewritePath).toBe("/api/.well-known/ucp");
    expect(r.requestHeader("x-mm-custom-domain")).toBe("1");
  });

  it("serves the seller-scoped UCP endpoint even when no slug resolves", async () => {
    mockLookup.mockResolvedValue({ slug: null, pubkey: null });
    const res = await proxy(buildRequest("farmer.example", PATH));
    expect(inspect(res).rewritePath).toBe("/api/.well-known/ucp");
  });

  it("rewrites to the owner-scoped UCP endpoint on self-host", async () => {
    const prevEnabled = process.env.MM_SELF_HOST;
    const prevSlug = process.env.MM_SELF_HOST_SLUG;
    process.env.MM_SELF_HOST = "1";
    process.env.MM_SELF_HOST_SLUG = "acme";
    try {
      const res = await proxy(buildRequest("myfarm.example", PATH));
      expect(inspect(res).rewritePath).toBe("/api/.well-known/ucp");
    } finally {
      if (prevEnabled === undefined) delete process.env.MM_SELF_HOST;
      else process.env.MM_SELF_HOST = prevEnabled;
      if (prevSlug === undefined) delete process.env.MM_SELF_HOST_SLUG;
      else process.env.MM_SELF_HOST_SLUG = prevSlug;
    }
  });
});
