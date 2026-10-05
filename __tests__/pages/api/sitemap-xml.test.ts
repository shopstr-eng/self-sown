/** @jest-environment node */

/**
 * Sitemap custom-domain canonicalization (task: list sellers' custom domains
 * instead of platform stall URLs).
 *
 * The stall pages 308 /stall/<slug> to a seller's LIVE custom domain, so the
 * sitemap — a strong canonicalization hint — must list the custom-domain
 * origin (root-mapped) for those stalls' stall + blog entries. The gate
 * mirrors utils/storefront/stall-custom-domain-redirect.ts: verified AND
 * tls_status "active" AND membership not hidden. Sellers without a live
 * domain keep their platform /stall/<slug> entries.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { SITE_URL } from "@/utils/site-url";

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({
  query: (...args: any[]) => mockQuery(...args),
  release: mockRelease,
}));
const mockFetchBlogRows = jest.fn(async (..._args: any[]) => [] as any[]);
const mockGetMembershipView = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(() => ({ connect: mockConnect })),
  fetchStorefrontBlogPostEventsForSitemap: (...args: any[]) =>
    mockFetchBlogRows(...args),
}));

jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: (...args: any[]) => mockGetMembershipView(...args),
}));

import handler from "@/pages/api/sitemap.xml";

const CUSTOM_PK = "a".repeat(64);
const HIDDEN_PK = "b".repeat(64);
const PENDING_TLS_PK = "c".repeat(64);
const PLATFORM_PK = "d".repeat(64);

function blogEvent(pubkey: string, dTag: string, title: string) {
  return {
    id: `id-${dTag}`,
    pubkey,
    created_at: 1_700_000_000,
    kind: 30023,
    tags: [
      ["d", dTag],
      ["title", title],
    ],
    content: "Body",
    sig: "sig",
  };
}

function stubTables({
  stalls,
  domains,
  blogRows = [],
  listings = [],
  failDomainsQuery = false,
}: {
  stalls: Array<{ slug: string; pubkey: string; created_at: number }>;
  domains: Array<{ pubkey: string; domain: string }>;
  blogRows?: Array<{ slug: string; event: any }>;
  listings?: Array<{ d_tag: string; created_at: number }>;
  failDomainsQuery?: boolean;
}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM shop_slugs")) return { rows: stalls };
    if (sql.includes("FROM custom_domains")) {
      if (failDomainsQuery) throw new Error("relation custom_domains does not exist");
      return { rows: domains };
    }
    if (sql.includes("FROM product_events")) return { rows: listings };
    if (sql.includes("FROM community_events")) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  mockFetchBlogRows.mockResolvedValue(blogRows);
}

async function renderSitemap(): Promise<string> {
  const res: any = {
    setHeader: jest.fn(),
    send: jest.fn(),
  };
  res.status = jest.fn(() => res);
  await handler({} as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.send.mock.calls[0][0] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Everyone is a non-hidden, active member unless a test overrides.
  mockGetMembershipView.mockResolvedValue({ isHidden: false });
});

describe("sitemap.xml custom-domain entries", () => {
  it("lists the custom-domain origin (root-mapped) for a stall with a live verified domain", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
        { slug: "plain-shop", pubkey: PLATFORM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    // Root-mapped custom-domain origin for the stall entry…
    expect(xml).toContain(`<loc>https://shop.example.com</loc>`);
    // …and NO platform stall URL for that slug.
    expect(xml).not.toContain("/stall/custom-shop");
    // The marketplace vendor view is platform-only — it stays put.
    expect(xml).toContain(`${SITE_URL}/marketplace/custom-shop`);
    // A seller without a live domain keeps both platform entries.
    expect(xml).toContain(`${SITE_URL}/stall/plain-shop`);
    expect(xml).toContain(`${SITE_URL}/marketplace/plain-shop`);
    expect(mockGetMembershipView).toHaveBeenCalledWith(CUSTOM_PK);
  });

  it("lists blog posts under the custom domain without the /stall/<slug> prefix", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
        { slug: "plain-shop", pubkey: PLATFORM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      blogRows: [
        { slug: "custom-shop", event: blogEvent(CUSTOM_PK, "p1", "Hello World") },
        { slug: "plain-shop", event: blogEvent(PLATFORM_PK, "p2", "Plain Post") },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).toMatch(
      /<loc>https:\/\/shop\.example\.com\/blog\/[^<]+<\/loc>/
    );
    expect(xml).not.toContain("/stall/custom-shop/blog/");
    // Platform-only seller's blog entries keep the platform path.
    expect(xml).toContain(`${SITE_URL}/stall/plain-shop/blog/`);
  });

  it("keeps platform URLs for a hidden seller even with a live domain", async () => {
    mockGetMembershipView.mockResolvedValue({ isHidden: true });
    stubTables({
      stalls: [{ slug: "hidden-shop", pubkey: HIDDEN_PK, created_at: 1700000000 }],
      domains: [{ pubkey: HIDDEN_PK, domain: "hidden.example.com" }],
      blogRows: [
        { slug: "hidden-shop", event: blogEvent(HIDDEN_PK, "p1", "Hidden Post") },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("hidden.example.com");
    expect(xml).toContain(`${SITE_URL}/stall/hidden-shop`);
    expect(xml).toContain(`${SITE_URL}/stall/hidden-shop/blog/`);
  });

  it("keeps the platform URL when the domain is verified but TLS is not active (gate is enforced in SQL)", async () => {
    // The route filters tls_status = 'active' in the custom_domains query, so
    // a pending-TLS row simply never reaches the map. Assert the SQL carries
    // the filter and a seller with no matching row stays on the platform URL.
    stubTables({
      stalls: [
        { slug: "pending-shop", pubkey: PENDING_TLS_PK, created_at: 1700000000 },
      ],
      domains: [],
    });

    const xml = await renderSitemap();

    const domainQuery = mockQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("FROM custom_domains")
    )?.[0] as string;
    expect(domainQuery).toContain("verified = true");
    expect(domainQuery).toContain("tls_status = 'active'");
    expect(xml).toContain(`${SITE_URL}/stall/pending-shop`);
    expect(mockGetMembershipView).not.toHaveBeenCalled();
  });

  it("falls back to platform URLs when the membership lookup fails", async () => {
    mockGetMembershipView.mockRejectedValue(new Error("db down"));
    stubTables({
      stalls: [{ slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 }],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    expect(xml).toContain(`${SITE_URL}/stall/custom-shop`);
  });

  it("keeps stall, marketplace, and listing entries when the custom-domain query fails", async () => {
    stubTables({
      stalls: [{ slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 }],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [{ d_tag: "prod-1", created_at: 1700000000 }],
      failDomainsQuery: true,
    });

    const xml = await renderSitemap();

    // The failed domain lookup must not escape the dynamic block: every
    // already-fetchable entry survives, all as platform URLs.
    expect(xml).not.toContain("shop.example.com");
    expect(xml).toContain(`${SITE_URL}/stall/custom-shop`);
    expect(xml).toContain(`${SITE_URL}/marketplace/custom-shop`);
    expect(xml).toContain(`${SITE_URL}/listing/prod-1`);
    // The remaining dynamic queries still ran after the failure.
    const queried = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(queried.some((s) => s.includes("FROM product_events"))).toBe(true);
    expect(queried.some((s) => s.includes("FROM community_events"))).toBe(true);
    expect(mockGetMembershipView).not.toHaveBeenCalled();
  });

  it("releases the pooled client before any membership lookup (no nested pool acquisition)", async () => {
    const callOrder: string[] = [];
    mockRelease.mockImplementation(() => {
      callOrder.push("release");
    });
    mockGetMembershipView.mockImplementation(async () => {
      callOrder.push("membership");
      return { isHidden: false };
    });
    stubTables({
      stalls: [{ slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 }],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    // getMembershipView checks out its own pool connection; if it ran while
    // the sitemap still held its client, concurrent sitemap requests could
    // exhaust the pool (max 10) waiting on each other.
    expect(callOrder).toEqual(["release", "membership"]);
    expect(xml).toContain(`<loc>https://shop.example.com</loc>`);
  });
});
