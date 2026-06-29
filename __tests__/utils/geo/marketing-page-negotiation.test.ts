/** @jest-environment node */

// Routing-layer coverage for the platform-host marketing/legal pages that
// proxy.ts content-negotiates via AGENT_VIEW_PATHS (proxy.ts ~line 314).
//
// Unlike the per-stall surfaces (stall homepage, blog posts, GEO files) which
// rewrite to /api/stall-agent-view, the public marketing/legal pages —
//   /, /about, /faq, /contact, /producer-guide, /terms, /privacy
// — are served as tailored markdown/JSON/plain-text via /api/agent-view for
// agents (Accept header or known LLM UA) while browsers and HTML-only
// social/SEO bots keep getting the HTML SSR page (so OpenGraph/link previews
// and SEO stay intact).
//
// This block fires ONLY on the platform host. Custom domains fall through to
// their own storefront routing (a marketing path like /about on a seller domain
// must NOT be diverted to /api/agent-view).
//
// The harness mirrors blog-post-negotiation.test.ts /
// stall-home-geo-negotiation.test.ts: build a real NextRequest, call proxy(),
// and assert on the x-middleware-rewrite + x-middleware-request-* headers.

import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { proxy } from "@/proxy";

// The custom-domain branch resolves the seller slug/pubkey for the request host
// via lookupByHost (DB/cache backed). Stub it so the routing test is hermetic.
jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: "acme", pubkey: null })),
}));

const AGENT_UA = "GPTBot/1.0";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TWITTERBOT_UA = "Twitterbot/1.0";

// Every path proxy.ts negotiates for agents on the platform host.
const MARKETING_PATHS = [
  "/",
  "/about",
  "/faq",
  "/contact",
  "/producer-guide",
  "/terms",
  "/privacy",
];

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

// Assert the request was handed off to the marketing agent view with the
// original path + negotiated format wired through both query AND request header.
function expectAgentView(
  res: NextResponse,
  { path, format }: { path: string; format: string }
) {
  const r = inspect(res);
  expect(r.rewritePath).toBe("/api/agent-view");
  expect(r.rewriteParams?.get("path")).toBe(path);
  expect(r.rewriteParams?.get("format")).toBe(format);
  // The endpoint also reads path/format from request headers (rewrite can
  // clobber the destination query with the original request's).
  expect(r.requestHeader("x-agent-view-path")).toBe(path);
  expect(r.requestHeader("x-agent-view-format")).toBe(format);
}

// Assert the request was NOT diverted to the marketing machine view — it keeps
// rendering the HTML page (falling through or routed elsewhere, never to
// /api/agent-view).
function expectHtmlPage(res: NextResponse) {
  const r = inspect(res);
  expect(r.rewritePath).not.toBe("/api/agent-view");
}

// --- Platform host: each marketing path negotiates for agents ----------------

describe("proxy() marketing-page negotiation — platform host", () => {
  const HOST = "milk.market";

  it.each(MARKETING_PATHS)(
    "rewrites an LLM crawler on %s to the agent view (markdown)",
    async (path) => {
      const res = await proxy(buildRequest(HOST, path, { ua: AGENT_UA }));
      expectAgentView(res, { path, format: "md" });
    }
  );

  it.each(MARKETING_PATHS)(
    "rewrites an explicit JSON Accept header on %s to the agent view (json)",
    async (path) => {
      const res = await proxy(
        buildRequest(HOST, path, {
          accept: "application/json",
          ua: BROWSER_UA,
        })
      );
      expectAgentView(res, { path, format: "json" });
    }
  );

  it.each(MARKETING_PATHS)(
    "rewrites an explicit markdown Accept header on %s to the agent view (md)",
    async (path) => {
      const res = await proxy(
        buildRequest(HOST, path, {
          accept: "text/markdown",
          ua: BROWSER_UA,
        })
      );
      expectAgentView(res, { path, format: "md" });
    }
  );

  it.each(MARKETING_PATHS)(
    "rewrites a text/plain-only Accept header on %s to the agent view (txt)",
    async (path) => {
      const res = await proxy(
        buildRequest(HOST, path, { accept: "text/plain", ua: BROWSER_UA })
      );
      expectAgentView(res, { path, format: "txt" });
    }
  );

  it.each(MARKETING_PATHS)(
    "keeps a normal browser on %s on the HTML page",
    async (path) => {
      const res = await proxy(
        buildRequest(HOST, path, {
          accept: "text/html,application/xhtml+xml",
          ua: BROWSER_UA,
        })
      );
      expectHtmlPage(res);
    }
  );

  it.each(MARKETING_PATHS)(
    "keeps an HTML-only social bot on %s on the HTML page",
    async (path) => {
      const res = await proxy(buildRequest(HOST, path, { ua: TWITTERBOT_UA }));
      expectHtmlPage(res);
    }
  );

  it("sets Vary: Accept, User-Agent on the negotiated agent response", async () => {
    const res = await proxy(buildRequest(HOST, "/about", { ua: AGENT_UA }));
    expect(res.headers.get("Vary")).toBe("Accept, User-Agent");
  });
});

// --- Custom domains fall through to their own routing ------------------------

// On a seller custom domain the platform marketing/legal block must NOT fire —
// these paths belong to the seller's storefront routing, never the platform's
// /api/agent-view. (We use /about + /faq rather than "/", which a custom domain
// negotiates separately as the stall homepage.)
describe("proxy() marketing-page negotiation — custom domains fall through", () => {
  const HOST = "farmer.example";
  const SELLER_PATHS = ["/about", "/faq", "/contact", "/terms", "/privacy"];

  it.each(SELLER_PATHS)(
    "does NOT divert an LLM crawler on %s to /api/agent-view",
    async (path) => {
      const res = await proxy(buildRequest(HOST, path, { ua: AGENT_UA }));
      expect(inspect(res).rewritePath).not.toBe("/api/agent-view");
    }
  );

  it.each(SELLER_PATHS)(
    "does NOT divert an explicit JSON Accept header on %s to /api/agent-view",
    async (path) => {
      const res = await proxy(
        buildRequest(HOST, path, {
          accept: "application/json",
          ua: BROWSER_UA,
        })
      );
      expect(inspect(res).rewritePath).not.toBe("/api/agent-view");
    }
  );
});
