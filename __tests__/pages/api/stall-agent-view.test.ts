/** @jest-environment node */

// Endpoint-layer coverage for the per-stall Pro gate in stall-agent-view.
//
// The geo negotiation suites (utils/geo/*negotiation.test.ts) prove proxy.ts
// ROUTES agent requests here; this block exercises the endpoint DIRECTLY to
// prove the membership gate: machine-readable stall/blog content is a Pro
// feature (parity with the HTML page gating OG meta/JSON-LD on
// membership.isPro), so lapsed sellers get a fail-closed 403 — in JSON, or in
// markdown for agents that negotiate text/markdown — BEFORE any product/blog
// content is fetched or rendered.

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "@/pages/api/stall-agent-view";
import { getMembershipView } from "@/utils/pro/membership";
import {
  fetchShopPubkeyBySlug,
  fetchProductsByPubkeyFromDb,
  fetchBlogPostsByPubkeyFromDb,
} from "@/utils/db/db-service";

// Deterministic rate limiting: the shared limiter is exercised in
// utils/__tests__/rate-limit.test.ts; here every request is allowed.
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => Promise.resolve(true)),
}));

// The membership resolver is covered by utils/pro tests; here we stub the
// resolved view so each test picks the seller's entitlement directly.
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  fetchShopPubkeyBySlug: jest.fn(),
  fetchShopProfileByPubkeyFromDb: jest.fn(() =>
    Promise.resolve({ content: JSON.stringify({ name: "Farm Shop" }) })
  ),
  fetchProfileByPubkeyFromDb: jest.fn(() => Promise.resolve(null)),
  fetchProductsByPubkeyFromDb: jest.fn(() => Promise.resolve([])),
  fetchBlogPostsByPubkeyFromDb: jest.fn(() => Promise.resolve([])),
}));

const mockGetMembershipView = getMembershipView as jest.Mock;
const mockFetchShopPubkeyBySlug = fetchShopPubkeyBySlug as jest.Mock;
const mockFetchProducts = fetchProductsByPubkeyFromDb as jest.Mock;
const mockFetchBlogPosts = fetchBlogPostsByPubkeyFromDb as jest.Mock;

const PRO_VIEW = { isPro: true, status: "active" };
const LAPSED_VIEW = { isPro: false, status: "hidden" };

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
    end(payload?: unknown) {
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

function createRequest(opts: {
  slug?: string;
  format?: string;
  postSlug?: string;
  accept?: string;
}): NextApiRequest {
  const headers: Record<string, string> = {};
  if (opts.slug) headers["x-stall-slug"] = opts.slug;
  if (opts.format) headers["x-stall-format"] = opts.format;
  if (opts.postSlug) headers["x-post-slug"] = opts.postSlug;
  if (opts.accept) headers.accept = opts.accept;
  return {
    method: "GET",
    headers,
    query: {},
    socket: { remoteAddress: "203.0.113.42" },
  } as unknown as NextApiRequest;
}

async function run(
  opts: Parameters<typeof createRequest>[0]
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await handler(createRequest(opts), res as unknown as NextApiResponse);
  return res;
}

describe("/api/stall-agent-view — Pro membership gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchShopPubkeyBySlug.mockImplementation((slug: string) =>
      Promise.resolve(slug === "farm" ? "seller-pubkey" : null)
    );
    mockGetMembershipView.mockResolvedValue(PRO_VIEW);
  });

  it("serves the stall markdown view for a Pro seller", async () => {
    const res = await run({ slug: "farm", format: "md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/markdown");
    expect(String(res.body)).toContain("Farm Shop");
    // Entitlement-gated content must never sit in a shared cache — a cached
    // 200 would keep serving content after the seller lapses.
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("serves the per-stall agents.txt for a Pro seller", async () => {
    const res = await run({ slug: "farm", format: "agents" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/plain");
    expect(String(res.body)).toContain("Farm Shop — AI agent access");
    expect(String(res.body)).toContain("/.well-known/ucp");
  });

  it("derives self-host agents.txt URLs from the request host (loopback → http, port kept)", async () => {
    // Self-host dev: the discovery URLs must match the serving origin exactly
    // (same scheme/port authority rule as the RFC 9728 metadata route).
    const req = createRequest({ slug: "farm", format: "agents" });
    (req.headers as Record<string, string>)["x-ss-custom-domain-host"] =
      "localhost:3333";
    const res = createResponse();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("http://localhost:3333/llms.txt");
    expect(String(res.body)).not.toContain("https://localhost");
  });

  it("falls back to the ?host= query param when the x-ss header was stripped (second proxy pass)", async () => {
    // The standalone runtime re-runs the proxy on the internal rewrite target
    // and the platform branch strips x-ss-* headers there; the custom domain
    // must still reach the handler via the query string so discovery URLs
    // render under the seller's origin, not the platform's.
    const req = createRequest({ slug: "farm", format: "agents" });
    (req.query as Record<string, string>).host = "shop.example.com";
    const res = createResponse();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("https://shop.example.com/llms.txt");
  });

  it("prefers the x-ss-custom-domain-host header over the ?host= query param", async () => {
    const req = createRequest({ slug: "farm", format: "agents" });
    (req.headers as Record<string, string>)["x-ss-custom-domain-host"] =
      "header.example.com";
    (req.query as Record<string, string>).host = "query.example.com";
    const res = createResponse();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("https://header.example.com/llms.txt");
    expect(String(res.body)).not.toContain("query.example.com");
  });

  it("returns 403 pro_required JSON for a lapsed seller, before fetching content", async () => {
    mockGetMembershipView.mockResolvedValue(LAPSED_VIEW);
    const res = await run({ slug: "farm", format: "md" });
    expect(res.statusCode).toBe(403);
    // ...and a cached 403 must not punish a seller who just renewed.
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(res.headers["Content-Type"]).toContain("application/json");
    const body = res.body as { code?: string; slug?: string };
    expect(body.code).toBe("pro_required");
    expect(body.slug).toBe("farm");
    // Fail-closed AND cheap: the gate precedes the heavy inventory fetches.
    expect(mockFetchProducts).not.toHaveBeenCalled();
    expect(mockFetchBlogPosts).not.toHaveBeenCalled();
  });

  it("returns a markdown 403 when the agent negotiates text/markdown", async () => {
    mockGetMembershipView.mockResolvedValue(LAPSED_VIEW);
    const res = await run({
      slug: "farm",
      format: "json",
      accept: "text/markdown",
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["Content-Type"]).toContain("text/markdown");
    expect(String(res.body)).toContain("403 Pro Required");
    expect(String(res.body)).not.toContain("Farm Shop");
  });

  it("gates single blog post bodies too, not just the stall index", async () => {
    mockGetMembershipView.mockResolvedValue(LAPSED_VIEW);
    const res = await run({ slug: "farm", postSlug: "harvest-notes" });
    expect(res.statusCode).toBe(403);
    expect((res.body as { code?: string }).code).toBe("pro_required");
    expect(mockFetchBlogPosts).not.toHaveBeenCalled();
  });

  it("gates feed/sitemap formats for lapsed sellers", async () => {
    mockGetMembershipView.mockResolvedValue(LAPSED_VIEW);
    for (const format of ["rss", "sitemap", "robots", "llms", "agents"]) {
      const res = await run({ slug: "farm", format });
      expect(res.statusCode).toBe(403);
    }
  });

  it("fails closed to 500 (never silently 200/403) when membership lookup errors", async () => {
    mockGetMembershipView.mockRejectedValue(new Error("db down"));
    const res = await run({ slug: "farm", format: "md" });
    expect(res.statusCode).toBe(500);
    expect((res.body as { code?: string }).code).toBe("stall_render_error");
  });

  it("still 404s unknown slugs before any membership check", async () => {
    const res = await run({ slug: "nope", format: "md" });
    expect(res.statusCode).toBe(404);
    expect(mockGetMembershipView).not.toHaveBeenCalled();
  });
});
