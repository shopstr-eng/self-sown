/** @jest-environment node */

// Routing-layer coverage for /blog/<slug> content negotiation (proxy.ts).
// The single-post agent view must be reachable in ALL machine formats —
// including the llms-style variant, which has no standard Accept media type and
// is therefore only reachable via the explicit `?format=` override. Browsers
// and SEO/social bots must keep getting the HTML article untouched.
//
// Two layers are covered:
//   1. `negotiatePostFormat` — the pure Accept/UA/?format decision.
//   2. The full `proxy()` request router — asserting that a blog post path is
//      actually rewritten to /api/stall-agent-view (with postSlug + format set,
//      both as query params AND as the x-post-slug request header the endpoint
//      reads) for agents, but falls through to the HTML article for browsers and
//      HTML-only bots. The negotiation logic is duplicated across three host
//      branches (platform /stall/<slug>/blog/<postSlug>, custom domain
//      /blog/<postSlug>, self-host /blog/<postSlug>), so each is exercised.

import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { negotiatePostFormat, proxy } from "@/proxy";

// The custom-domain branch resolves the seller slug for the request host via
// lookupByHost (DB/cache backed). Stub it so the routing test is hermetic.
jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: "acme", pubkey: null })),
}));

// Minimal NextRequest stand-in for the pure-helper tests: negotiatePostFormat
// only reads request.nextUrl.searchParams.
const req = (query = ""): NextRequest =>
  ({
    nextUrl: { searchParams: new URLSearchParams(query) },
  }) as unknown as NextRequest;

const AGENT_UA = "GPTBot/1.0";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TWITTERBOT_UA = "Twitterbot/1.0";

describe("negotiatePostFormat — explicit ?format override", () => {
  it("makes the llms-style variant reachable (no standard Accept type)", () => {
    expect(negotiatePostFormat(req("format=llms"), "", AGENT_UA)).toBe("llms");
    // Even with a plain browser Accept, the explicit agent request wins.
    expect(
      negotiatePostFormat(req("format=llms"), "text/html", BROWSER_UA)
    ).toBe("llms");
  });

  it("honors every explicit machine format", () => {
    expect(negotiatePostFormat(req("format=md"), "", BROWSER_UA)).toBe("md");
    expect(negotiatePostFormat(req("format=json"), "", BROWSER_UA)).toBe(
      "json"
    );
    expect(negotiatePostFormat(req("format=txt"), "", BROWSER_UA)).toBe("txt");
  });

  it("ignores an unknown explicit format and falls back to negotiation", () => {
    // ?format=xml is not a supported variant → fall back; browser gets HTML.
    expect(
      negotiatePostFormat(req("format=xml"), "text/html", BROWSER_UA)
    ).toBe(null);
    // ...but Accept-based negotiation still applies on the fallback path.
    expect(
      negotiatePostFormat(req("format=xml"), "application/json", AGENT_UA)
    ).toBe("json");
  });

  it("never serves a machine format to HTML-only bots, even when asked", () => {
    // Link unfurlers occasionally append stray query params; they must still
    // receive the HTML page so previews keep working.
    expect(negotiatePostFormat(req("format=llms"), "", TWITTERBOT_UA)).toBe(
      null
    );
    expect(negotiatePostFormat(req("format=md"), "", TWITTERBOT_UA)).toBe(null);
  });
});

describe("negotiatePostFormat — Accept/User-Agent fallback", () => {
  it("returns markdown/json from explicit Accept headers", () => {
    expect(negotiatePostFormat(req(), "text/markdown", BROWSER_UA)).toBe("md");
    expect(negotiatePostFormat(req(), "application/json", BROWSER_UA)).toBe(
      "json"
    );
  });

  it("returns markdown for known LLM crawler user-agents", () => {
    expect(negotiatePostFormat(req(), "", AGENT_UA)).toBe("md");
  });

  it("leaves normal browser navigation on HTML", () => {
    expect(
      negotiatePostFormat(req(), "text/html,application/xhtml+xml", BROWSER_UA)
    ).toBe(null);
  });
});

// --- Full proxy() routing across all three host branches ---------------------

const POST_SLUG = "raw-milk-101";

// Build a real NextRequest the proxy can route. `query` lets a test append e.g.
// `format=llms` to the blog URL.
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
    // Where (if anywhere) the request was internally rewritten to.
    rewritePath: rewrite?.pathname ?? null,
    rewriteParams: rewrite?.searchParams ?? null,
    // True when proxy just let the request continue to its normal page.
    fellThrough: res.headers.get("x-middleware-next") === "1",
    // Overridden request headers forwarded to the rewrite target.
    requestHeader: (name: string) =>
      res.headers.get(`x-middleware-request-${name}`),
  };
}

// Assert an agent request was handed off to the single-post agent view with the
// post slug + negotiated format wired through both query AND header.
function expectAgentView(
  res: NextResponse,
  { slug, format }: { slug: string; format: string }
) {
  const r = inspect(res);
  expect(r.rewritePath).toBe("/api/stall-agent-view");
  expect(r.rewriteParams?.get("slug")).toBe(slug);
  expect(r.rewriteParams?.get("postSlug")).toBe(POST_SLUG);
  expect(r.rewriteParams?.get("format")).toBe(format);
  // The endpoint reads the post slug from the x-post-slug request header.
  expect(r.requestHeader("x-post-slug")).toBe(POST_SLUG);
  expect(r.requestHeader("x-stall-format")).toBe(format);
}

// Assert the request was NOT diverted to the machine view — i.e. it keeps
// rendering the HTML article (either falling through or rewritten to the HTML
// stall page, never to /api/stall-agent-view).
function expectHtmlArticle(res: NextResponse) {
  const r = inspect(res);
  expect(r.rewritePath).not.toBe("/api/stall-agent-view");
}

describe("proxy() blog negotiation — platform host /stall/<slug>/blog/<postSlug>", () => {
  const HOST = "milk.market";
  const PATH = `/stall/acme/blog/${POST_SLUG}`;

  it("rewrites an LLM crawler to the agent view (markdown)", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: AGENT_UA }));
    expectAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit machine Accept header to the agent view (json)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "application/json", ua: BROWSER_UA })
    );
    expectAgentView(res, { slug: "acme", format: "json" });
  });

  it("honors the ?format=llms override", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { ua: AGENT_UA, query: "format=llms" })
    );
    expectAgentView(res, { slug: "acme", format: "llms" });
  });

  it("keeps a normal browser on the HTML article", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlArticle(res);
  });

  it("keeps an HTML-only social bot on the HTML article", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlArticle(res);
  });
});

describe("proxy() blog negotiation — custom domain /blog/<postSlug>", () => {
  const HOST = "farmer.example";
  const PATH = `/blog/${POST_SLUG}`;

  it("rewrites an LLM crawler to the agent view (markdown)", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: AGENT_UA }));
    expectAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit machine Accept header to the agent view (markdown)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/markdown", ua: BROWSER_UA })
    );
    expectAgentView(res, { slug: "acme", format: "md" });
  });

  it("honors the ?format=llms override", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { ua: AGENT_UA, query: "format=llms" })
    );
    expectAgentView(res, { slug: "acme", format: "llms" });
  });

  it("keeps a normal browser on the HTML article", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlArticle(res);
  });

  it("keeps an HTML-only social bot on the HTML article", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlArticle(res);
  });
});

describe("proxy() blog negotiation — self-host /blog/<postSlug>", () => {
  const HOST = "myfarm.example";
  const PATH = `/blog/${POST_SLUG}`;

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
    expectAgentView(res, { slug: "acme", format: "md" });
  });

  it("rewrites an explicit machine Accept header to the agent view (json)", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "application/json", ua: BROWSER_UA })
    );
    expectAgentView(res, { slug: "acme", format: "json" });
  });

  it("honors the ?format=llms override", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { ua: AGENT_UA, query: "format=llms" })
    );
    expectAgentView(res, { slug: "acme", format: "llms" });
  });

  it("keeps a normal browser on the HTML article", async () => {
    const res = await proxy(
      buildRequest(HOST, PATH, { accept: "text/html", ua: BROWSER_UA })
    );
    expectHtmlArticle(res);
  });

  it("keeps an HTML-only social bot on the HTML article", async () => {
    const res = await proxy(buildRequest(HOST, PATH, { ua: TWITTERBOT_UA }));
    expectHtmlArticle(res);
  });
});
