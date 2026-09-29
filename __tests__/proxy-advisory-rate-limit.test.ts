/** @jest-environment node */

// Advisory RateLimit headers (proxy.ts withAdvisoryRateLimitHeaders). The
// numeric RateLimit-* budget (600 req/min) is real only where a limiter
// enforces it: /api/mcp + /api/mcp/status (agents.txt's documented agent
// surface). Plain HTML navigations and every other API/well-known route have
// no such limiter, so stamping a constant "600 of 600 remaining" on them
// claimed a budget nothing grants or tracks. Only /api/mcp* paths keep the
// advisory; routes with a real limiter (x-ss-rl-skip marker or their own
// RateLimit-* headers) are never double-stamped.
//
// NEXT_PUBLIC_BASE_URL is captured at module import time, so it is stubbed
// and proxy re-required inside jest.isolateModules (same pattern as
// proxy-legacy-host.test.ts).

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: null, pubkey: null })),
}));

function loadProxy(): typeof import("@/proxy").proxy {
  process.env.NEXT_PUBLIC_BASE_URL = "https://self-sown.com";
  let proxyFn: typeof import("@/proxy").proxy | undefined;
  jest.isolateModules(() => {
    proxyFn = require("@/proxy").proxy;
  });
  return proxyFn!;
}

function buildRequest(
  path: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`https://self-sown.com${path}`, {
    headers: { host: "self-sown.com", ...headers },
  });
}

describe("advisory RateLimit headers", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("stamps NO numeric rate-limit budget on plain HTML navigations", async () => {
    const proxy = loadProxy();
    const res = await proxy(
      buildRequest("/about", {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0",
      })
    );
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
    expect(res.headers.get("RateLimit-Remaining")).toBeNull();
    expect(res.headers.get("RateLimit-Reset")).toBeNull();
    expect(res.headers.get("RateLimit-Policy")).toBeNull();
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("stamps no budget on navigations with a default */* accept either", async () => {
    const proxy = loadProxy();
    const res = await proxy(buildRequest("/stall/some-store"));
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("keeps the documented agent budget on /api/mcp paths", async () => {
    const proxy = loadProxy();
    for (const path of ["/api/mcp", "/api/mcp/status"]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBe("600");
      expect(res.headers.get("RateLimit-Remaining")).toBe("600");
      expect(res.headers.get("RateLimit-Reset")).toBe("60");
      expect(res.headers.get("RateLimit-Policy")).toBe('"agent";q=600;w=60');
    }
  });

  it("stamps NO budget on other /api/ routes without their own limiter", async () => {
    const proxy = loadProxy();
    // No 600/60s limiter enforces anything on arbitrary API routes, so the
    // advisory must not claim one. Routes with their own (different) limiter
    // stamp their own accurate headers via applyRateLimit.
    for (const path of ["/api/some-endpoint", "/api/db/fetch-products"]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Remaining")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
  });

  it("stamps NO 600 budget on /api/mcp/* siblings with their own tighter limits", async () => {
    const proxy = loadProxy();
    // Onboard enforces 10/hour (and stamps its own headers via
    // reportRateLimit); api-keys 30/min, create-order 60/min, etc. The
    // proxy must never stamp the 600/60s advisory on these paths — least of
    // all on their 429s.
    for (const path of [
      "/api/mcp/onboard",
      "/api/mcp/api-keys",
      "/api/mcp/create-order",
      "/api/mcp/verify-payment",
      "/api/mcp/set-nsec",
    ]) {
      const res = await proxy(buildRequest(path));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
    }
  });

  it("stamps NO budget on /.well-known/ files without their own limiter", async () => {
    const proxy = loadProxy();
    // agent.json has no limiter; the UCP + signature-directory routes enforce
    // their own 600/60s and stamp their own headers (or opt out via the skip
    // marker), so the proxy adds nothing either way.
    const res = await proxy(buildRequest("/.well-known/agent.json"));
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("stamps NO budget on the custom-domain /api/mcp rejection", async () => {
    const proxy = loadProxy();
    // /api/mcp is not in the custom-domain API allowlist, so the proxy 403s
    // it there without any limiter running — the response must not inherit
    // the platform's documented budget.
    const res = await proxy(
      buildRequest("/api/mcp", { host: "shop.farmer.example" })
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("leaves agent-negotiated page formats to their real upstream limiter", async () => {
    const proxy = loadProxy();
    // /about with a markdown Accept rewrites to /api/agent-view, which
    // enforces its own per-agent budget — the proxy must not stamp the
    // advisory over (or alongside) those accurate headers.
    const res = await proxy(
      buildRequest("/about", { accept: "text/markdown" })
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("leaves known LLM agent user agents to their real upstream limiter", async () => {
    const proxy = loadProxy();
    // ClaudeBot on a stall page rewrites to stall-agent-view (rate-limited).
    const res = await proxy(
      buildRequest("/stall/some-store", { "user-agent": "ClaudeBot/1.0" })
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("stamps no budget when an LLM bot gets the HTML page (no agent-view rewrite)", async () => {
    const proxy = loadProxy();
    // /listing/<product> has no agent-view rewrite: even a recognized LLM
    // crawler falls through to the HTML product page, which no 600/60s
    // limiter covers — the advisory must not claim one.
    const headerCases: Record<string, string>[] = [
      { "user-agent": "ClaudeBot/1.0" },
      { accept: "text/markdown" },
      { accept: "application/json", "user-agent": "GPTBot/1.0" },
    ];
    for (const headers of headerCases) {
      const res = await proxy(buildRequest("/listing/abc123", headers));
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
      expect(res.headers.get("RateLimit-Remaining")).toBeNull();
      expect(res.headers.get("RateLimit-Policy")).toBeNull();
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
  });

  it("strips the skip marker and adds nothing where a route opts out (real limiter upstream)", async () => {
    const proxy = loadProxy();
    // The Web Bot Auth directory route sets x-ss-rl-skip itself.
    const res = await proxy(
      buildRequest("/.well-known/http-message-signatures-directory")
    );
    expect(res.headers.get("x-ss-rl-skip")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });
});

// --- Machine-facing branch guard (structural) -------------------------------
// The behavioral tests above pin the CURRENT routing table, but a future
// agent-readable branch added to proxy.ts without the x-ss-rl-skip marker
// would silently re-introduce the unenforced 600/60s advisory on that surface
// (the same class of leak fixed for the custom-domain /api/mcp 403). This
// guard statically enumerates every proxy branch that RETURNS machine-facing
// content — a rewrite to an /api/ route, a NextResponse.json body, or a
// constructed NextResponse — and asserts each one either sets RL_SKIP_HEADER
// (a real limiter upstream owns accurate headers) or is explicitly allowlisted
// below as a branch where the advisory is intentional/unreachable. A new
// unmarked branch fails this test until its author either sets the marker or
// consciously allowlists it here.

interface MachineFacingSite {
  key: string;
  hasMarker: boolean;
}

function scanMachineFacingSites(src: string): MachineFacingSite[] {
  const sites: MachineFacingSite[] = [];

  // For a response assigned to a variable (`const res = NextResponse...`),
  // the marker must appear before the branch's `return`. Fail-closed: if the
  // branch shape ever confuses this scan, the site reads as unmarked and the
  // guard test fails loudly rather than waving a leak through.
  const markerAfter = (fromIdx: number): boolean => {
    const rest = src.slice(fromIdx, fromIdx + 1200);
    const ret = rest.search(/\breturn\b/);
    const region = ret === -1 ? rest : rest.slice(0, ret);
    return region.includes("RL_SKIP_HEADER");
  };
  const inlineReturn = (callIdx: number, callee: string): boolean => {
    const before = src.slice(Math.max(0, callIdx - 200), callIdx);
    return new RegExp(`return\\s+${callee}\\s*\\(\\s*$`).test(before);
  };

  // Rewrites whose destination is an /api/ route (agent views, well-known
  // discovery files, per-seller agent/GEO files).
  const urlRe = /new URL\(\s*["'`](\/api\/[^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(src)) !== null) {
    sites.push({
      key: `rewrite:${m[1]}`,
      hasMarker: inlineReturn(m.index, "NextResponse\\.rewrite")
        ? false
        : markerAfter(m.index),
    });
  }

  // Proxy-generated JSON responses (version-pin rejection, domain gates).
  const jsonRe = /NextResponse\.json\s*\(/g;
  while ((m = jsonRe.exec(src)) !== null) {
    const args = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    // Key on the first string literal OR callee identifier in the args —
    // whichever comes first (the window may spill into following code, so a
    // later string must not beat an earlier identifier).
    const str = args.match(/"([^"]+)"/);
    const ident = args.match(/([A-Za-z_$][\w$]*)\s*\(/);
    const first =
      str && (!ident || (str.index as number) < (ident.index as number))
        ? str[1]
        : ident
          ? ident[1]
          : args.slice(0, 40).trim();
    sites.push({
      key: `json:${first}`,
      hasMarker: inlineReturn(m.index, "NextResponse\\.json")
        ? false
        : markerAfter(m.index),
    });
  }

  // Proxy-constructed bodies (e.g. the self-host misconfiguration 503).
  const rawRe = /new NextResponse\(/g;
  while ((m = rawRe.exec(src)) !== null) {
    const args = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const str = args.match(/"([^"]+)"/);
    const key = `response:${str ? str[1] : args.slice(0, 40).trim()}`;
    sites.push({
      key,
      hasMarker: inlineReturn(m.index, "new NextResponse")
        ? false
        : markerAfter(m.index),
    });
  }

  return sites;
}

// Machine-facing branches that intentionally do NOT set x-ss-rl-skip, with the
// reason each is safe. Keyed as a multiset: a second unmarked branch serving
// the same destination (e.g. another /.well-known/ucp rewrite) still fails.
const ADVISORY_EXEMPT_BRANCHES = [
  // Version-pin 400: only ever stamped when the path is /api/mcp(/status) —
  // the documented budget surface itself — where "600 of 600" is accurate
  // because the request was rejected before consuming anything.
  "json:unsupportedApiVersionBody",
  // Host-neutral discovery rewrites: the request path is /.well-known/*, never
  // /api/mcp*, so the advisory predicate cannot fire on these responses; the
  // upstream routes own their headers.
  "rewrite:/api/.well-known/agent.json",
  "rewrite:/api/.well-known/apple-developer-merchantid-domain-association",
  // Platform-host UCP rewrite only — the custom-domain and self-host UCP
  // branches DO set the marker, so exactly one unmarked occurrence remains.
  "rewrite:/api/.well-known/ucp",
  // Self-host blocked-billing-API 404: billing/Connect paths are never
  // /api/mcp*, so the advisory predicate cannot fire.
  "json:Not available on this instance",
  // Self-host misconfiguration 503 (plain text). Can be served under
  // /api/mcp, where the stamp is the documented budget for that endpoint and
  // no limiter state exists to under- or over-report.
  "response:Self-host mode is enabled (SS_SELF_HOST) but SS_SELF_HOST_SLUG is ",
].sort();

describe("up-front rejections vs the advisory stamp", () => {
  // The documented convention (openapi x-rate-limit-policy): requests rejected
  // before a limiter runs MAY omit numeric headers — and the behavior differs
  // by path, so pin both sides.
  it("STILL stamps the advisory budget on an up-front API-Version 400 for /api/mcp", async () => {
    const proxy = loadProxy();
    const res = await proxy(buildRequest("/api/mcp", { "api-version": "99" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("stamps NO numeric headers on an up-front API-Version 400 for other routes", async () => {
    const proxy = loadProxy();
    const res = await proxy(
      buildRequest("/api/ucp/catalog/search", { "api-version": "99" })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });
});

describe("oauth-protected-resource host scoping", () => {
  // RFC 9728 §3.3: metadata is only valid when the serving host matches the
  // resource identifier — so the rewrite fires on the exact canonical host and
  // nowhere else (legacy aliases, seller domains, previews).
  function metadataRequest(host: string): NextRequest {
    return new NextRequest(
      `https://${host}/.well-known/oauth-protected-resource`,
      { headers: { host } }
    );
  }

  it("serves the metadata on the canonical host", async () => {
    const proxy = loadProxy();
    const res = await proxy(metadataRequest("self-sown.com"));
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/api/.well-known/oauth-protected-resource"
    );
  });

  it("does NOT serve platform metadata on the legacy domain", async () => {
    const proxy = loadProxy();
    const res = await proxy(metadataRequest("milk.market"));
    expect(res.headers.get("x-middleware-rewrite") ?? "").not.toContain(
      "/api/.well-known/oauth-protected-resource"
    );
  });

  it("does NOT serve platform metadata on seller custom domains", async () => {
    const proxy = loadProxy();
    // Custom domains rewrite unknown paths to their stall renderer — fine —
    // but never to the platform's metadata API route.
    const res = await proxy(metadataRequest("farm.example"));
    expect(res.headers.get("x-middleware-rewrite") ?? "").not.toContain(
      "/api/.well-known/oauth-protected-resource"
    );
  });
});

describe("machine-facing branch guard (proxy.ts structure)", () => {
  const PROXY_SRC = fs.readFileSync(
    path.join(__dirname, "..", "proxy.ts"),
    "utf8"
  );

  it("every agent/API response branch sets x-ss-rl-skip or is allowlisted", () => {
    const sites = scanMachineFacingSites(PROXY_SRC);
    // Sanity: the scanner must actually see the routing table — a proxy.ts
    // refactor that silently emptied this list would neuter the guard.
    expect(sites.length).toBeGreaterThanOrEqual(15);
    const unmarked = sites
      .filter((s) => !s.hasMarker)
      .map((s) => s.key)
      .sort();
    // If this fails because you ADDED a machine-facing branch: set
    // `res.headers.set(RL_SKIP_HEADER, "1")` on its response when a real
    // limiter runs upstream, or add it to ADVISORY_EXEMPT_BRANCHES above with
    // a justification. Do not just delete this test.
    expect(unmarked).toEqual(ADVISORY_EXEMPT_BRANCHES);
  });

  it("the scanner itself flags a hypothetical unmarked agent route", () => {
    // Meta-test for the done criteria: a new agent-readable branch without
    // the marker must show up as unmarked (and thus fail the guard above).
    const hypothetical = `${PROXY_SRC}\nif (pathname === "/.well-known/future-discovery") {\n  return NextResponse.rewrite(new URL("/api/.well-known/future-discovery", request.url));\n}\n`;
    const sites = scanMachineFacingSites(hypothetical);
    const unmarked = sites.filter((s) => !s.hasMarker).map((s) => s.key);
    expect(unmarked).toContain("rewrite:/api/.well-known/future-discovery");
  });
});
