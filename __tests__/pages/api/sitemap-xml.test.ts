/** @jest-environment node */

/**
 * Sitemap custom-domain EXCLUSION. Google rejects sitemap entries on a
 * different host than the sitemap itself ("URL not allowed for a Sitemap at
 * this location"), and the platform stall/listing/blog URLs of a seller with
 * a LIVE custom domain all 308 to that domain — a sitemap should list final
 * URLs, not redirects. So custom-domain sellers' stall, listing, and blog
 * entries are omitted from the platform sitemap; their content is advertised
 * by the custom domain's own /sitemap.xml (served per-domain by the proxy).
 *
 * The gate mirrors utils/storefront/stall-custom-domain-redirect.ts: verified
 * AND tls_status "active" AND membership not hidden. Sellers without a live
 * domain (or when a lookup fails) keep their platform entries.
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
  listings?: Array<{
    id?: string;
    pubkey?: string;
    title?: string | null;
    created_at: number;
  }>;
  failDomainsQuery?: boolean;
}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM shop_slugs")) return { rows: stalls };
    if (sql.includes("FROM custom_domains")) {
      if (failDomainsQuery)
        throw new Error("relation custom_domains does not exist");
      return { rows: domains };
    }
    // The real query returns newest-first (ORDER BY created_at DESC, id
    // DESC) and the sitemap's serving-winner simulation relies on that
    // order — mirror it so tests can't pass on an order the SQL never
    // produces.
    if (sql.includes("FROM product_events"))
      return {
        rows: [...listings].sort((a, b) => b.created_at - a.created_at),
      };
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
  it("excludes the stall entry (but keeps the marketplace view) for a stall with a live verified domain", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
        { slug: "plain-shop", pubkey: PLATFORM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    // No cross-domain URLs — GSC rejects them ("URL not allowed").
    expect(xml).not.toContain("shop.example.com");
    // The platform stall URL 308s to the custom domain, so it is omitted too.
    expect(xml).not.toContain("/stall/custom-shop");
    // The marketplace vendor view does NOT redirect — it stays put.
    expect(xml).toContain(`${SITE_URL}/marketplace/custom-shop`);
    // A seller without a live domain keeps both platform entries.
    expect(xml).toContain(`${SITE_URL}/stall/plain-shop`);
    expect(xml).toContain(`${SITE_URL}/marketplace/plain-shop`);
    expect(mockGetMembershipView).toHaveBeenCalledWith(CUSTOM_PK);
  });

  it("excludes a custom-domain stall's blog posts from the platform sitemap", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
        { slug: "plain-shop", pubkey: PLATFORM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      blogRows: [
        {
          slug: "custom-shop",
          event: blogEvent(CUSTOM_PK, "p1", "Hello World"),
        },
        {
          slug: "plain-shop",
          event: blogEvent(PLATFORM_PK, "p2", "Plain Post"),
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    expect(xml).not.toContain("/stall/custom-shop/blog/");
    // Platform-only seller's blog entries keep the platform path.
    expect(xml).toContain(`${SITE_URL}/stall/plain-shop/blog/`);
  });

  it("keeps platform URLs for a hidden seller even with a live domain", async () => {
    mockGetMembershipView.mockResolvedValue({ isHidden: true });
    stubTables({
      stalls: [
        { slug: "hidden-shop", pubkey: HIDDEN_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: HIDDEN_PK, domain: "hidden.example.com" }],
      blogRows: [
        {
          slug: "hidden-shop",
          event: blogEvent(HIDDEN_PK, "p1", "Hidden Post"),
        },
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
        {
          slug: "pending-shop",
          pubkey: PENDING_TLS_PK,
          created_at: 1700000000,
        },
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
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    expect(xml).toContain(`${SITE_URL}/stall/custom-shop`);
  });

  it("excludes a custom-domain seller's products from the platform sitemap", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
        { slug: "plain-shop", pubkey: PLATFORM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [
        {
          id: "e".repeat(64),
          pubkey: CUSTOM_PK,
          title: "prod-custom",
          created_at: 1700000000,
        },
        {
          id: "f".repeat(64),
          pubkey: PLATFORM_PK,
          title: "prod-plain",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    // Cross-domain entries are GSC-illegal…
    expect(xml).not.toContain("shop.example.com");
    // …and the platform listing URL 308s to the domain, so it is omitted too.
    expect(xml).not.toContain("/listing/prod-custom");
    // A platform-only seller's product keeps its platform entry.
    expect(xml).toContain(`${SITE_URL}/listing/prod-plain`);
  });

  it("keeps a hidden seller's products on the platform URL even with a live domain", async () => {
    mockGetMembershipView.mockResolvedValue({ isHidden: true });
    stubTables({
      stalls: [
        { slug: "hidden-shop", pubkey: HIDDEN_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: HIDDEN_PK, domain: "hidden.example.com" }],
      listings: [
        {
          id: "2".repeat(64),
          pubkey: HIDDEN_PK,
          title: "prod-hidden",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("hidden.example.com");
    expect(xml).toContain(`${SITE_URL}/listing/prod-hidden`);
  });

  it("keeps products on the platform URL when the custom-domain query fails", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [
        {
          id: "3".repeat(64),
          pubkey: CUSTOM_PK,
          title: "prod-custom",
          created_at: 1700000000,
        },
      ],
      failDomainsQuery: true,
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    expect(xml).toContain(`${SITE_URL}/listing/prod-custom`);
  });

  it("keeps stall, marketplace, and listing entries when the custom-domain query fails", async () => {
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [
        {
          id: "4".repeat(64),
          pubkey: CUSTOM_PK,
          title: "prod-1",
          created_at: 1700000000,
        },
      ],
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

  it("emits the canonical title-slug URL the listing page serves, never the raw d-tag", async () => {
    // The listing page's SSR resolves only naddr / event id / title slug — a
    // raw d-tag URL 404s. The sitemap must advertise the same canonical
    // title slug the page itself settles on (resolveListingCanonicalUrl).
    stubTables({
      stalls: [],
      domains: [],
      listings: [
        {
          id: "5".repeat(64),
          pubkey: PLATFORM_PK,
          title: "Fresh Eggs",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).toContain(`${SITE_URL}/listing/Fresh-Eggs`);
    // No event-id URL when a title slug exists.
    expect(xml).not.toContain(`/listing/${"5".repeat(64)}`);
  });

  it("falls back to the event id for a title-less product (resolvable via fetchProductByIdFromDb)", async () => {
    stubTables({
      stalls: [],
      domains: [],
      listings: [
        {
          id: "6".repeat(64),
          pubkey: PLATFORM_PK,
          title: null,
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).toContain(`${SITE_URL}/listing/${"6".repeat(64)}`);
  });

  it("adds the pubkey-suffix disambiguation for same-seller title collisions, matching the page canonical", async () => {
    stubTables({
      stalls: [],
      domains: [],
      listings: [
        {
          id: "7".repeat(64),
          pubkey: PLATFORM_PK,
          title: "Raw Honey",
          created_at: 1700000001,
        },
        {
          id: "8".repeat(64),
          pubkey: PLATFORM_PK,
          title: "Raw Honey",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    const suffix = PLATFORM_PK.substring(0, 8);
    expect(xml).toContain(
      `${SITE_URL}/listing/${encodeURIComponent(`Raw-Honey-${suffix}`)}`
    );
    // The ambiguous bare slug must not be advertised for either product.
    expect(xml).not.toContain(`${SITE_URL}/listing/Raw-Honey<`);
  });

  it("does NOT suffix same-title products from DIFFERENT sellers (collision scope is per-seller, like the page)", async () => {
    stubTables({
      stalls: [],
      domains: [],
      listings: [
        {
          id: "9".repeat(64),
          pubkey: PLATFORM_PK,
          title: "Sourdough",
          created_at: 1700000001,
        },
        {
          id: "0".repeat(64),
          pubkey: CUSTOM_PK,
          title: "Sourdough",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).toContain(`${SITE_URL}/listing/Sourdough`);
    expect(xml).not.toContain("Sourdough-");
    // Both sellers slug to the SAME bare URL, but only one product can be
    // served there — emit it once (the newest, matching the page's global
    // newest-first slug scan), never a duplicate <loc>.
    const occurrences = xml.split(`${SITE_URL}/listing/Sourdough<`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("omits the shared slug entirely when a live-custom-domain seller's newer product wins it", async () => {
    // The page's slug scan is global and newest-first: /listing/Fresh-Eggs
    // serves the custom-domain seller's product and 308s to their domain.
    // Advertising the platform URL would violate the sitemap's final-URL
    // policy AND fail to advertise the platform seller's older product (the
    // URL can't serve it) — so the slug is omitted from the platform
    // sitemap altogether.
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [
        {
          id: "a1".repeat(32),
          pubkey: CUSTOM_PK,
          title: "Fresh Eggs",
          created_at: 1700000001, // newer — wins the shared slug
        },
        {
          id: "b2".repeat(32),
          pubkey: PLATFORM_PK,
          title: "Fresh Eggs",
          created_at: 1700000000,
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    expect(xml).not.toContain("/listing/Fresh-Eggs");
  });

  it("advertises the shared slug when the PLATFORM seller's newer product wins it", async () => {
    // Same collision, but the platform seller owns the newest product: the
    // URL serves their listing with no redirect, so it belongs in the
    // sitemap (once), and the custom-domain seller's older product is not
    // advertised on the platform.
    stubTables({
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
      listings: [
        {
          id: "a1".repeat(32),
          pubkey: CUSTOM_PK,
          title: "Fresh Eggs",
          created_at: 1700000000, // older
        },
        {
          id: "b2".repeat(32),
          pubkey: PLATFORM_PK,
          title: "Fresh Eggs",
          created_at: 1700000001, // newer — wins the shared slug
        },
      ],
    });

    const xml = await renderSitemap();

    expect(xml).not.toContain("shop.example.com");
    const occurrences = xml.split(`${SITE_URL}/listing/Fresh-Eggs<`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("queries only the latest version per (pubkey, d-tag) so edited listings advertise one current URL", async () => {
    stubTables({ stalls: [], domains: [] });

    await renderSitemap();

    const listingsQuery = mockQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("FROM product_events")
    )?.[0] as string;
    expect(listingsQuery).toContain("DISTINCT ON (p.pubkey, d.d_tag)");
    expect(listingsQuery).toContain("p.created_at DESC");
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
      stalls: [
        { slug: "custom-shop", pubkey: CUSTOM_PK, created_at: 1700000000 },
      ],
      domains: [{ pubkey: CUSTOM_PK, domain: "shop.example.com" }],
    });

    const xml = await renderSitemap();

    // getMembershipView checks out its own pool connection; if it ran while
    // the sitemap still held its client, concurrent sitemap requests could
    // exhaust the pool (max 10) waiting on each other.
    expect(callOrder).toEqual(["release", "membership"]);
    expect(xml).not.toContain("shop.example.com");
  });
});
