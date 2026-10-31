/**
 * @jest-environment node
 *
 * Regression coverage for the listing-page slug lookup contract
 * (fetchProductByListingSlug), which defines which product a /listing/<slug>
 * URL actually SERVES — the sitemap (pages/api/sitemap.xml.ts) mirrors it to
 * decide which listing URLs to advertise.
 *
 * Two pinned behaviors:
 *
 * 1. The query dedups to the LATEST version per (pubkey, d-tag) — the same
 *    dedup the marketplace (fetchAllProductsFromDb) and the sitemap apply.
 *    Without it, a renamed product's stale historical version can still win
 *    a slug that now belongs to another listing, serving the wrong product.
 *    (product_events keeps every version; id is the primary key.)
 * 2. Rows are scanned newest-first; findListingBySlug's plain-match branch
 *    takes the FIRST row carrying the title slug, which must be the newest
 *    event with that title — across ALL sellers, not per seller.
 */

import { fetchProductByListingSlug } from "@/utils/db/db-service";

type MockClient = {
  queries: string[];
  rows: any[];
  query: jest.Mock;
  release: jest.Mock;
};

// Shared with the pg mock factory below (jest hoisting requires the "mock"
// prefix for out-of-scope references).
const mockState = {
  clients: [] as MockClient[],
  rows: [] as any[],
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    connect: jest.fn(async () => {
      const client: MockClient = {
        queries: [],
        rows: mockState.rows,
        query: jest.fn(async (text: any, _params?: any[]) => {
          client.queries.push(typeof text === "string" ? text : "");
          return { rows: mockState.rows, rowCount: mockState.rows.length };
        }),
        release: jest.fn(),
      };
      mockState.clients.push(client);
      return client;
    }),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    on: jest.fn(),
    end: jest.fn(async () => {}),
  })),
}));

const SELLER_A = "a".repeat(64);
const SELLER_B = "b".repeat(64);

function productRow(overrides: {
  id: string;
  pubkey: string;
  title: string;
  created_at: number;
  dTag?: string;
}) {
  return {
    id: overrides.id,
    pubkey: overrides.pubkey,
    created_at: overrides.created_at,
    kind: 30402,
    tags: [
      ["d", overrides.dTag ?? overrides.id.slice(0, 12)],
      ["title", overrides.title],
    ],
    content: "",
    sig: "sig",
  };
}

beforeEach(() => {
  mockState.clients = [];
  mockState.rows = [];
});

describe("fetchProductByListingSlug", () => {
  it("dedups product_events to the latest version per (pubkey, d-tag)", async () => {
    await fetchProductByListingSlug("anything");

    // getDbPool's schema bootstrap runs its own DDL batch on connect; find
    // the lookup query itself.
    const sql = mockState.clients
      .flatMap((c) => c.queries)
      .find((q) => q.includes("FROM product_events"))!;
    // The dedup clause is the contract: without it, stale historical
    // versions (e.g. a renamed product's old title event) stay in the scan
    // and can win a slug that now belongs to another listing.
    expect(sql).toContain("DISTINCT ON (p.pubkey, d.d_tag)");
    expect(sql).toContain("p.created_at DESC");
    expect(sql).toContain("ORDER BY pe.created_at DESC");
  });

  it("resolves a renamed listing's OLD title to the other seller's current product, not the stale version", async () => {
    // Seller A renamed their product "Raw Milk" -> "A2 Milk": the deduped
    // query returns only the LATEST version (titled "A2 Milk"). Seller B has
    // a current product titled "Raw Milk". The slug /listing/Raw-Milk must
    // resolve to seller B's product — seller A's stale event is no longer in
    // the scan. (The rows below are what the deduped query returns: A's old
    // "Raw Milk" version is already gone.)
    mockState.rows = [
      productRow({
        id: "c".repeat(64),
        pubkey: SELLER_A,
        title: "A2 Milk",
        created_at: 2000,
      }),
      productRow({
        id: "d".repeat(64),
        pubkey: SELLER_B,
        title: "Raw Milk",
        created_at: 1500,
      }),
    ];

    const event = await fetchProductByListingSlug("Raw-Milk");

    expect(event).not.toBeNull();
    expect(event!.id).toBe("d".repeat(64));
    expect(event!.pubkey).toBe(SELLER_B);
  });

  it("picks the NEWEST product across sellers when two share a title slug", async () => {
    // Rows arrive newest-first (the query's ORDER BY); the plain-match
    // branch takes the first row with the slug, so the winner is the
    // globally newest product with that title — the behavior the sitemap's
    // winner simulation relies on.
    mockState.rows = [
      productRow({
        id: "e".repeat(64),
        pubkey: SELLER_B,
        title: "Fresh Eggs",
        created_at: 2000,
      }),
      productRow({
        id: "f".repeat(64),
        pubkey: SELLER_A,
        title: "Fresh Eggs",
        created_at: 1000,
      }),
    ];

    const event = await fetchProductByListingSlug("Fresh-Eggs");

    expect(event!.id).toBe("e".repeat(64));
    expect(event!.pubkey).toBe(SELLER_B);
  });

  it("honors the pubkey-suffix disambiguation for same-seller title collisions", async () => {
    mockState.rows = [
      productRow({
        id: "1".repeat(64),
        pubkey: SELLER_A,
        title: "Raw Honey",
        created_at: 2000,
      }),
      productRow({
        id: "2".repeat(64),
        pubkey: SELLER_A,
        title: "Raw Honey",
        created_at: 1000,
      }),
    ];

    const event = await fetchProductByListingSlug(
      `Raw-Honey-${SELLER_A.substring(0, 8)}`
    );

    // Both match the suffix; the newest-first scan returns the newer one —
    // the product the sitemap advertises for this slug.
    expect(event!.id).toBe("1".repeat(64));
  });
});
