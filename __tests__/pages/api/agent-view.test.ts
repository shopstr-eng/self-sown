/** @jest-environment node */

// Endpoint-layer coverage for the platform marketing/legal agent view.
//
// marketing-page-negotiation.test.ts proves proxy.ts ROUTES the platform-host
// marketing/legal pages (/, /about, /faq, /contact, /producer-guide, /terms,
// /privacy) to /api/agent-view with the right negotiated format. It stops at
// the routing decision. This block exercises pages/api/agent-view.ts DIRECTLY
// to prove the endpoint then produces the correct representation: a non-empty
// body, the right content-type, the content that matches the requested page,
// read from BOTH the x-agent-view-path/x-agent-view-format request headers and
// the query params (the proxy forwards both), and a fail-closed response for an
// unknown path or format.

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "@/pages/api/agent-view";
import { PAGE_CONTENT } from "@/utils/geo/page-content";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

// Force the rate limiter onto its deterministic in-memory fallback. The shared
// Postgres store is exercised in utils/__tests__/rate-limit.test.ts; here we
// want hermetic, per-test-resettable counting (the limit-walking tests below
// fire 600+ requests and rely on __resetRateLimitBuckets between tests), so we
// make the shared-store accessor throw and let checkRateLimit fall back.
jest.mock("@/utils/db/db-service", () => ({
  incrementRateLimitCounter: jest.fn(() => {
    throw new Error("db disabled in agent-view endpoint test");
  }),
  cleanupExpiredRateLimitCounters: jest.fn(() => Promise.resolve()),
}));

// Every path proxy.ts negotiates for agents on the platform host — must match
// the routing harness's MARKETING_PATHS exactly.
const MARKETING_PATHS = [
  "/",
  "/about",
  "/faq",
  "/contact",
  "/producer-guide",
  "/terms",
  "/privacy",
];

// A distinctive phrase from each page's markdown, used to prove the endpoint
// returned the representation for the REQUESTED path (not a stale/wrong page).
const PAGE_FINGERPRINT: Record<string, string> = {
  "/": "# Milk Market",
  "/about": "# About Milk Market",
  "/faq": "# Milk Market FAQ",
  "/contact": "# Contact Milk Market",
  "/producer-guide": "# Producer Guide",
  "/terms": "# Terms of Service",
  "/privacy": "# Privacy Policy",
};

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key];
    },
  };
}

type Source = "header" | "query";

// Build a request that carries path/format via request headers OR query params,
// mirroring how proxy.ts forwards both.
function createRequest(
  path: string,
  format: string | undefined,
  source: Source
): NextApiRequest {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  if (source === "header") {
    headers["x-agent-view-path"] = path;
    if (format !== undefined) headers["x-agent-view-format"] = format;
  } else {
    query.path = path;
    if (format !== undefined) query.format = format;
  }
  return {
    method: "GET",
    headers,
    query,
    socket: { remoteAddress: "203.0.113.42" },
  } as unknown as NextApiRequest;
}

async function run(
  path: string,
  format: string | undefined,
  source: Source
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await handler(
    createRequest(path, format, source),
    res as unknown as NextApiResponse
  );
  return res;
}

describe("/api/agent-view — endpoint representation", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
  });

  // The proxy can clobber the destination query with the original request's
  // query, so the endpoint must read from request headers too. Run the whole
  // matrix from both sources.
  describe.each<Source>(["header", "query"])("via %s", (source) => {
    it.each(MARKETING_PATHS)(
      "returns the markdown representation for %s (default format)",
      async (path) => {
        const res = await run(path, "md", source);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe(
          "text/markdown; charset=utf-8"
        );
        const body = res.body as string;
        expect(typeof body).toBe("string");
        expect(body.length).toBeGreaterThan(0);
        // Content matches the requested page, not a different one.
        expect(body).toContain(PAGE_FINGERPRINT[path]);
      }
    );

    it.each(MARKETING_PATHS)(
      "defaults to markdown when no format is supplied for %s",
      async (path) => {
        const res = await run(path, undefined, source);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe(
          "text/markdown; charset=utf-8"
        );
        const body = res.body as string;
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain(PAGE_FINGERPRINT[path]);
      }
    );

    it.each(MARKETING_PATHS)(
      "returns the JSON representation for %s",
      async (path) => {
        const res = await run(path, "json", source);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe(
          "application/json; charset=utf-8"
        );
        const body = res.body as {
          path: string;
          title: string;
          description: string;
          content: string;
          links: { html: string; llms: string; skill: string };
        };
        expect(body.path).toBe(path);
        expect(body.title).toBe(PAGE_CONTENT[path].title);
        expect(body.description).toBe(PAGE_CONTENT[path].description);
        expect(body.content).toBe(PAGE_CONTENT[path].markdown);
        expect(body.content.length).toBeGreaterThan(0);
        expect(body.content).toContain(PAGE_FINGERPRINT[path]);
        expect(body.links.html).toBe(`https://milk.market${path}`);
      }
    );

    it.each(MARKETING_PATHS)(
      "returns the plain-text representation for %s",
      async (path) => {
        const res = await run(path, "txt", source);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
        const body = res.body as string;
        expect(typeof body).toBe("string");
        expect(body.length).toBeGreaterThan(0);
        // Markdown syntax is stripped: no leading "# " heading markers remain.
        expect(body).not.toMatch(/^#+\s/m);
        // But the page's distinctive heading text (sans the # markers) survives.
        const headingText = PAGE_FINGERPRINT[path].replace(/^#+\s+/, "");
        expect(body).toContain(headingText);
      }
    );
  });

  it("reads path/format from request headers even when the query disagrees", async () => {
    // proxy.ts forwards the original path/format via headers; a stray/leftover
    // query param must not win over the explicit header.
    const res = createResponse();
    const req = {
      method: "GET",
      headers: {
        "x-agent-view-path": "/faq",
        "x-agent-view-format": "json",
      },
      query: { path: "/about", format: "md" },
      socket: { remoteAddress: "203.0.113.43" },
    } as unknown as NextApiRequest;

    await handler(req, res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    const body = res.body as { path: string; content: string };
    expect(body.path).toBe("/faq");
    expect(body.content).toContain("# Milk Market FAQ");
  });

  it("falls back to the query when no header is present", async () => {
    const res = await run("/about", "md", "query");
    expect(res.statusCode).toBe(200);
    expect(res.body as string).toContain("# About Milk Market");
  });

  describe("fail-closed behaviour", () => {
    it("returns a 404 structured error for an unknown path", async () => {
      const res = await run("/does-not-exist", "md", "header");

      expect(res.statusCode).toBe(404);
      expect(res.headers["Content-Type"]).toBe(
        "application/json; charset=utf-8"
      );
      const body = res.body as { code: string; status: number; path: string };
      expect(body.code).toBe("not_found");
      expect(body.status).toBe(404);
      expect(body.path).toBe("/does-not-exist");
    });

    it("does not leak another page's content for an unknown path", async () => {
      const res = await run("/does-not-exist", "md", "header");
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("# About Milk Market");
      expect(serialized).not.toContain("# Milk Market FAQ");
    });

    it("falls back to the homepage when no path is supplied at all", async () => {
      const res = await run("", undefined, "header");
      // rawPath is empty → defaults to "/".
      expect(res.statusCode).toBe(200);
      expect(res.body as string).toContain("# Milk Market");
    });

    it("treats an unknown format as markdown rather than emitting HTML or empty", async () => {
      const res = await run("/about", "html", "header");

      expect(res.statusCode).toBe(200);
      // Unknown format falls through to the markdown branch — never HTML.
      expect(res.headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
      const body = res.body as string;
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("# About Milk Market");
      expect(body).not.toContain("<!DOCTYPE");
      expect(body).not.toContain("<html");
    });

    it("normalizes a trailing slash so /about/ resolves to /about", async () => {
      const res = await run("/about/", "md", "header");
      expect(res.statusCode).toBe(200);
      expect(res.body as string).toContain("# About Milk Market");
    });
  });

  it("sets agent-friendly caching/CORS headers on a successful response", async () => {
    const res = await run("/about", "md", "header");
    expect(res.headers["Vary"]).toBe("Accept, User-Agent");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["X-Robots-Tag"]).toBe("noindex");
  });
});

// Rate-limiting coverage. agent-view buckets on the requester IP (600/min)
// BEFORE returning content. Behind the platform proxy many unrelated agents can
// share one upstream IP, so the way getRequestIp keys requests directly decides
// whether a normal crawl gets the homepage/FAQ or a flood of empty 429s. These
// tests pin: (1) distinct requesters get independent budgets, (2) forwarded-for
// is honored ONLY from a trusted proxy (matching utils/rate-limit.ts), (3) a
// normal crawl volume stays under the ceiling, and (4) a 429 still returns the
// structured `rate_limited` JSON body rather than an empty response.

const RATE_LIMIT_MAX = 600;

function createRateLimitRequest(opts: {
  remoteAddress?: string;
  forwardedFor?: string;
  realIp?: string;
  path?: string;
  format?: string;
}): NextApiRequest {
  const headers: Record<string, string> = {
    "x-agent-view-path": opts.path ?? "/",
    "x-agent-view-format": opts.format ?? "md",
  };
  if (opts.forwardedFor !== undefined)
    headers["x-forwarded-for"] = opts.forwardedFor;
  if (opts.realIp !== undefined) headers["x-real-ip"] = opts.realIp;
  return {
    method: "GET",
    headers,
    query: {},
    socket: { remoteAddress: opts.remoteAddress ?? "203.0.113.1" },
  } as unknown as NextApiRequest;
}

async function callHandler(
  req: NextApiRequest
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

// Fire `n` requests from the same request descriptor and return the last
// response. Used to walk a bucket up to (or over) its ceiling.
async function callHandlerTimes(
  req: NextApiRequest,
  n: number
): Promise<ReturnType<typeof createResponse>> {
  let last = createResponse();
  for (let i = 0; i < n; i++) {
    last = await callHandler(req);
  }
  return last;
}

describe("/api/agent-view — rate limiting", () => {
  const ENV_KEYS = ["TRUST_PROXY_HEADERS", "TRUSTED_PROXY_IPS"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    __resetRateLimitBuckets();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("gives distinct requester IPs independent budgets", async () => {
    // Exhaust IP A's whole budget.
    const reqA = createRateLimitRequest({ remoteAddress: "203.0.113.10" });
    const lastA = await callHandlerTimes(reqA, RATE_LIMIT_MAX);
    expect(lastA.statusCode).toBe(200);

    // The next request from A is rate-limited.
    const overA = await callHandler(reqA);
    expect(overA.statusCode).toBe(429);

    // A different IP is unaffected — it still gets real content, not a 429.
    const resB = await callHandler(
      createRateLimitRequest({ remoteAddress: "203.0.113.11" })
    );
    expect(resB.statusCode).toBe(200);
    expect(typeof resB.body).toBe("string");
    expect((resB.body as string).length).toBeGreaterThan(0);
  });

  it("ignores x-forwarded-for when the remote address is not a trusted proxy", async () => {
    // No trust env set: getRequestIp must key on the real socket address, so
    // two agents sharing an untrusted upstream IP share ONE budget regardless
    // of their (spoofable) forwarded-for. This is the fail-safe direction —
    // it never splits unrelated agents into more budget than the ceiling.
    const shared = "198.51.100.5";
    await callHandlerTimes(
      createRateLimitRequest({
        remoteAddress: shared,
        forwardedFor: "1.1.1.1",
      }),
      RATE_LIMIT_MAX
    );

    const res = await callHandler(
      createRateLimitRequest({ remoteAddress: shared, forwardedFor: "2.2.2.2" })
    );
    // Bucketed by the shared socket address — forwarded-for was NOT honored.
    expect(res.statusCode).toBe(429);
  });

  it("honors x-forwarded-for when proxy headers are globally trusted, isolating agents behind a shared proxy", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const proxyAddr = "198.51.100.5";

    // Exhaust the first agent's budget (its own forwarded-for identity).
    await callHandlerTimes(
      createRateLimitRequest({
        remoteAddress: proxyAddr,
        forwardedFor: "1.1.1.1",
      }),
      RATE_LIMIT_MAX
    );
    const over = await callHandler(
      createRateLimitRequest({
        remoteAddress: proxyAddr,
        forwardedFor: "1.1.1.1",
      })
    );
    expect(over.statusCode).toBe(429);

    // A different agent (distinct forwarded-for) behind the SAME proxy keeps
    // its own budget — it still gets content, never a flood of empty 429s.
    const res = await callHandler(
      createRateLimitRequest({
        remoteAddress: proxyAddr,
        forwardedFor: "2.2.2.2",
      })
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as string).length).toBeGreaterThan(0);
  });

  it("honors x-forwarded-for only from an explicitly allow-listed proxy IP", async () => {
    process.env.TRUSTED_PROXY_IPS = "198.51.100.9";

    // From the trusted proxy: forwarded-for isolates each agent.
    const trustedProxy = "198.51.100.9";
    await callHandlerTimes(
      createRateLimitRequest({
        remoteAddress: trustedProxy,
        forwardedFor: "9.9.9.9",
      }),
      RATE_LIMIT_MAX
    );
    const trustedOver = await callHandler(
      createRateLimitRequest({
        remoteAddress: trustedProxy,
        forwardedFor: "9.9.9.9",
      })
    );
    expect(trustedOver.statusCode).toBe(429);
    const trustedOther = await callHandler(
      createRateLimitRequest({
        remoteAddress: trustedProxy,
        forwardedFor: "8.8.8.8",
      })
    );
    expect(trustedOther.statusCode).toBe(200);

    // From a NON-trusted address, the same forwarded-for is ignored and the
    // budget keys on the socket address instead.
    const untrustedProxy = "203.0.113.77";
    await callHandlerTimes(
      createRateLimitRequest({
        remoteAddress: untrustedProxy,
        forwardedFor: "7.7.7.7",
      }),
      RATE_LIMIT_MAX
    );
    const untrustedSpoof = await callHandler(
      createRateLimitRequest({
        remoteAddress: untrustedProxy,
        forwardedFor: "6.6.6.6",
      })
    );
    expect(untrustedSpoof.statusCode).toBe(429);
  });

  it("lets a normal full crawl of every page (in every format) through without a single 429", async () => {
    // A realistic crawl — every marketing page in every representation, twice —
    // is 42 requests, far under the 600/min ceiling. None should be limited.
    const remoteAddress = "203.0.113.50";
    for (let pass = 0; pass < 2; pass++) {
      for (const path of MARKETING_PATHS) {
        for (const format of ["md", "json", "txt"]) {
          const res = await callHandler(
            createRateLimitRequest({ remoteAddress, path, format })
          );
          expect(res.statusCode).not.toBe(429);
          expect(res.statusCode).toBe(200);
        }
      }
    }
  });

  it("returns the structured rate_limited JSON error (not an empty body) on a 429", async () => {
    const req = createRateLimitRequest({ remoteAddress: "203.0.113.60" });
    await callHandlerTimes(req, RATE_LIMIT_MAX);

    const res = await callHandler(req);
    expect(res.statusCode).toBe(429);

    // The body must be a populated structured error, never empty/undefined.
    expect(res.body).toBeDefined();
    expect(res.body).not.toBeNull();
    const body = res.body as {
      error: string;
      code: string;
      retryAfterSeconds: number;
    };
    expect(body.code).toBe("rate_limited");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // And the agent gets back-off / budget headers so it can recover instead
    // of hammering: Retry-After plus the RateLimit-* set.
    expect(res.headers["Retry-After"]).toBeDefined();
    expect(res.headers["RateLimit-Limit"]).toBe(String(RATE_LIMIT_MAX));
    expect(res.headers["RateLimit-Remaining"]).toBe("0");
  });
});
