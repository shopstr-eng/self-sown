/** @jest-environment node */

// SSR subpage validation for pages/stall/[...stallPath].tsx. Regression cover
// for the custom-domain 404s: the nav's built-in pages, footer policy slugs,
// and custom pages (nested content.storefront.pages, routed by SLUG) all used
// to hit the generic "unknown subpage" 404. The validator must mirror the
// client renderer exactly: slug-only page resolution, the shared policy
// resolver's semantics, flag-gated wallet/community, and the Pro entitlement
// strip (basicStorefront) — non-Pro sellers' persisted premium config must
// not validate routes the client cannot render.

import type { GetServerSidePropsContext } from "next";

jest.mock("@/components/storefront/storefront-layout", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/storefront-load-error", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/themed-stall-orders", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/themed-blog", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/ss-spinner", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/utils/context/context", () => ({ ShopMapContext: {} }));
jest.mock("@/utils/storefront/use-storefront-lookup", () => ({
  useStorefrontLookup: jest.fn(),
}));
jest.mock("@/utils/api/agent-error", () => ({
  tryWriteAgentNotFound: jest.fn(() => false),
}));

const PUBKEY = "ab".repeat(32);
const fetchShopProfileByPubkeyFromDb = jest.fn();
const fetchBlogPostsByPubkeyFromDb = jest.fn(
  async (..._args: unknown[]): Promise<any[]> => []
);
const fetchProductsByPubkeyFromDb = jest.fn(
  async (..._args: unknown[]): Promise<any[]> => []
);
const getMembershipView = jest.fn();
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: (...args: unknown[]) => getMembershipView(...args),
}));
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchShopPubkeyBySlug: jest.fn(async () => PUBKEY),
  fetchShopProfileByPubkeyFromDb: (...args: unknown[]) =>
    fetchShopProfileByPubkeyFromDb(...args),
  fetchProfileByPubkeyFromDb: jest.fn(async () => null),
  fetchBlogPostsByPubkeyFromDb: (...args: unknown[]) =>
    fetchBlogPostsByPubkeyFromDb(...args),
  fetchProductsByPubkeyFromDb: (...args: unknown[]) =>
    fetchProductsByPubkeyFromDb(...args),
}));

import { getServerSideProps } from "@/pages/stall/[...stallPath]";
import { SITE_URL } from "@/utils/site-url";

function shopEvent(storefront?: Record<string, unknown>) {
  return {
    id: "evt",
    pubkey: PUBKEY,
    created_at: 1,
    kind: 30019,
    tags: [],
    sig: "sig",
    content: JSON.stringify({
      name: "naughty goat co.",
      about: "goat milk products",
      ...(storefront ? { storefront } : {}),
    }),
  };
}

function ctx(
  path: string[],
  headers: Record<string, string> = {}
): GetServerSidePropsContext {
  return {
    query: { stallPath: path },
    req: { headers },
    res: {},
  } as unknown as GetServerSidePropsContext;
}

const PAGES = [
  { id: "page-1774641080229", slug: "about", title: "About", sections: [] },
];

async function status(path: string[]): Promise<number> {
  const res = await getServerSideProps(ctx(path));
  return "notFound" in res ? 404 : 200;
}

describe("stall subpage SSR validation (Pro seller)", () => {
  beforeEach(() => {
    fetchShopProfileByPubkeyFromDb.mockReset();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ pages: PAGES })
    );
    getMembershipView.mockReset();
    getMembershipView.mockResolvedValue({ isPro: true });
  });

  it("serves every ungated built-in route", async () => {
    for (const slug of [
      "shop",
      "orders",
      "blog",
      "my-listings",
      "order-confirmation",
    ]) {
      expect(await status(["naughtygoatco", slug])).toBe(200);
    }
  });

  it("emits seller Store + BreadcrumbList JSON-LD on Pro subpages", async () => {
    const res = await getServerSideProps(ctx(["naughtygoatco", "shop"]));
    if (!("props" in res)) throw new Error("expected 200 props");
    const jsonLd = (res.props as { ogMeta: { jsonLd?: Record<string, any>[] } })
      .ogMeta.jsonLd;
    expect(jsonLd).toBeDefined();
    const types = jsonLd!.map((n) => n["@type"]);
    expect(types).toContain("Store");
    expect(types).toContain("BreadcrumbList");
    const store = jsonLd!.find((n) => n["@type"] === "Store")!;
    expect(store.name).toBe("naughty goat co.");
    expect(store.url).toBe(`${SITE_URL}/stall/naughtygoatco`);
    const crumbs = jsonLd!.find((n) => n["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement).toHaveLength(2);
    expect(crumbs.itemListElement[1].name).toBe("Shop");
    expect(crumbs.itemListElement[1].item).toBe(
      `${SITE_URL}/stall/naughtygoatco/shop`
    );
  });

  it("emits the same seller JSON-LD on the blog index early-return branch", async () => {
    // The blog branches return before the generic subpage ogMeta block — the
    // identity/breadcrumb nodes must not get lost on that path.
    const res = await getServerSideProps(ctx(["naughtygoatco", "blog"]));
    if (!("props" in res)) throw new Error("expected 200 props");
    const jsonLd = (res.props as { ogMeta: { jsonLd?: Record<string, any>[] } })
      .ogMeta.jsonLd;
    const types = (jsonLd ?? []).map((n) => n["@type"]);
    expect(types).toContain("Store");
    expect(types).toContain("BreadcrumbList");
    const crumbs = jsonLd!.find((n) => n["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement[1]).toMatchObject({
      name: "Blog",
      item: `${SITE_URL}/stall/naughtygoatco/blog`,
    });
  });

  it("emits seller Store + BreadcrumbList JSON-LD on subpages for a lapsed (non-Pro) seller", async () => {
    // Store identity is NOT a Pro perk: the stall homepage emits it for all
    // sellers, and a free stall's /shop subpage is often what actually ranks
    // in search. Only premium branding and the ItemList catalog stay gated.
    getMembershipView.mockResolvedValue({ isPro: false });
    const res = await getServerSideProps(ctx(["naughtygoatco", "shop"]));
    if (!("props" in res)) throw new Error("expected 200 props");
    const jsonLd = (res.props as { ogMeta: { jsonLd?: Record<string, any>[] } })
      .ogMeta.jsonLd;
    expect(jsonLd).toBeDefined();
    const types = jsonLd!.map((n) => n["@type"]);
    expect(types).toContain("Store");
    expect(types).toContain("BreadcrumbList");
    const store = jsonLd!.find((n) => n["@type"] === "Store")!;
    expect(store.name).toBe("naughty goat co.");
    expect(store.url).toBe(`${SITE_URL}/stall/naughtygoatco`);
    const crumbs = jsonLd!.find((n) => n["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement[1]).toMatchObject({
      name: "Shop",
      item: `${SITE_URL}/stall/naughtygoatco/shop`,
    });
  });

  it("emits seller Store + BreadcrumbList on non-Pro blog subpages too", async () => {
    getMembershipView.mockResolvedValue({ isPro: false });
    // Blog index.
    const index = await getServerSideProps(ctx(["naughtygoatco", "blog"]));
    if (!("props" in index)) throw new Error("expected 200 props");
    const indexTypes = (
      (index.props as { ogMeta: { jsonLd?: Record<string, any>[] } }).ogMeta
        .jsonLd ?? []
    ).map((n) => n["@type"]);
    expect(indexTypes).toEqual(
      expect.arrayContaining(["Store", "BreadcrumbList"])
    );
    // Single blog post: BlogPosting from eventToBlogOgMeta plus the same
    // identity/breadcrumb nodes.
    const post = {
      id: "post1",
      pubkey: PUBKEY,
      created_at: 1_700_000_100,
      kind: 30023,
      tags: [
        ["d", "why-raw-milk"],
        ["title", "Why raw milk matters"],
        ["summary", "A short note on freshness."],
        ["published_at", "1700000000"],
      ],
      content: "Body",
      sig: "sig",
    };
    fetchBlogPostsByPubkeyFromDb.mockResolvedValueOnce([post]);
    const single = await getServerSideProps(
      ctx(["naughtygoatco", "blog", "why-raw-milk"])
    );
    if (!("props" in single)) throw new Error("expected 200 props");
    const singleTypes = (
      (single.props as { ogMeta: { jsonLd?: Record<string, any>[] } }).ogMeta
        .jsonLd ?? []
    ).map((n) => n["@type"]);
    expect(singleTypes).toEqual(
      expect.arrayContaining(["Store", "BreadcrumbList", "BlogPosting"])
    );
  });

  it("builds blog-post JSON-LD with the seller-origin canonical URL on a custom domain", async () => {
    const post = {
      id: "post1",
      pubkey: PUBKEY,
      created_at: 1_700_000_100,
      kind: 30023,
      tags: [
        ["d", "why-raw-milk"],
        ["title", "Why raw milk matters"],
        ["summary", "A short note on freshness."],
        ["published_at", "1700000000"],
      ],
      content: "Body",
      sig: "sig",
    };
    fetchBlogPostsByPubkeyFromDb.mockResolvedValueOnce([post]);
    const res = await getServerSideProps(
      ctx(["naughtygoatco", "blog", "why-raw-milk"], {
        "x-ss-custom-domain-host": "naughtygoat.farm",
        "x-ss-original-path": "/blog/why-raw-milk",
      })
    );
    if (!("props" in res)) throw new Error("expected 200 props");
    const jsonLd = (res.props as { ogMeta: { jsonLd?: Record<string, any>[] } })
      .ogMeta.jsonLd;
    const types = (jsonLd ?? []).map((n) => n["@type"]);
    expect(types).toEqual(
      expect.arrayContaining(["Store", "BreadcrumbList", "BlogPosting"])
    );
    // Every node must use the seller's public origin — never the internal
    // /stall/* rewrite path or the platform host. The URL is the REQUESTED
    // public path, matching the HTML canonical DynamicHead derives from
    // x-ss-original-path ("/blog/why-raw-milk") — the two must agree.
    const canonical = "https://naughtygoat.farm/blog/why-raw-milk";
    const article = jsonLd!.find((n) => n["@type"] === "BlogPosting")!;
    expect(article.url).toBe(canonical);
    expect(article.url).not.toContain("/stall/");
    const crumbs = jsonLd!.find((n) => n["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement[2].item).toBe(canonical);
  });

  it("gates wallet and community on their storefront flags", async () => {
    expect(await status(["naughtygoatco", "wallet"])).toBe(404);
    expect(await status(["naughtygoatco", "community"])).toBe(404);
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ showWalletPage: true, showCommunityPage: true })
    );
    expect(await status(["naughtygoatco", "wallet"])).toBe(200);
    expect(await status(["naughtygoatco", "community"])).toBe(200);
  });

  it("serves policy pages enabled by default (no footer config)", async () => {
    for (const slug of [
      "return-policy",
      "terms-of-service",
      "privacy-policy",
      "cancellation-policy",
    ]) {
      expect(await status(["naughtygoatco", slug])).toBe(200);
    }
  });

  it("mirrors the shared policy resolver for every stored shape", async () => {
    // Explicitly disabled -> 404 (others stay enabled)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        footer: {
          policies: { privacyPolicy: { enabled: false, content: "" } },
        },
      })
    );
    expect(await status(["naughtygoatco", "privacy-policy"])).toBe(404);
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);

    // Stored but missing `enabled` -> renderer's (stored || default).enabled
    // is falsy, so it renders no policy; SSR must 404 too.
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ footer: { policies: { returnPolicy: { content: "x" } } } })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(404);

    // Stored and enabled -> 200 (truthy check, not === true)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        footer: { policies: { returnPolicy: { enabled: 1, content: "x" } } },
      })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);

    // Null stored value -> falls back to the default (enabled)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ footer: { policies: { returnPolicy: null } } })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);
  });

  it("serves custom pages by slug from content.storefront.pages", async () => {
    expect(await status(["naughtygoatco", "about"])).toBe(200);
  });

  it("404s a page id URL — the renderer only ever resolves slugs", async () => {
    expect(await status(["naughtygoatco", "page-1774641080229"])).toBe(404);
  });

  it("ignores a legacy top-level pages array the renderer cannot read", async () => {
    fetchShopProfileByPubkeyFromDb.mockResolvedValue({
      ...shopEvent(),
      content: JSON.stringify({ name: "legacy", pages: PAGES }),
    });
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });

  it("404s unknown subpages", async () => {
    expect(await status(["naughtygoatco", "nope"])).toBe(404);
  });

  it("rejects extra path segments beyond blog/<post>", async () => {
    expect(await status(["naughtygoatco", "about", "extra"])).toBe(404);
    expect(await status(["naughtygoatco", "shop", "extra"])).toBe(404);
    expect(await status(["naughtygoatco", "blog", "a", "b"])).toBe(404);
  });

  it("404s policy/custom pages when the shop event itself is missing", async () => {
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(null);
    expect(await status(["naughtygoatco", "return-policy"])).toBe(404);
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });
});

describe("stall subpage SSR validation (non-Pro seller)", () => {
  beforeEach(() => {
    fetchShopProfileByPubkeyFromDb.mockReset();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        pages: PAGES,
        showWalletPage: true,
        showCommunityPage: true,
        footer: { policies: { returnPolicy: { enabled: false, content: "" } } },
      })
    );
    getMembershipView.mockReset();
    getMembershipView.mockResolvedValue({ isPro: false });
  });

  it("404s persisted custom pages — the client strips them for non-Pro", async () => {
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });

  it("404s wallet/community even with persisted flags — stripped for non-Pro", async () => {
    expect(await status(["naughtygoatco", "wallet"])).toBe(404);
    expect(await status(["naughtygoatco", "community"])).toBe(404);
  });

  it("serves default policies and ignores stored ones, like the stripped client storefront", async () => {
    // Stored disabled policy is stripped with the footer, so the client falls
    // back to the enabled default policy — SSR must agree.
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);
    expect(await status(["naughtygoatco", "privacy-policy"])).toBe(200);
  });

  it("still serves ungated built-ins", async () => {
    expect(await status(["naughtygoatco", "shop"])).toBe(200);
    expect(await status(["naughtygoatco", "order-confirmation"])).toBe(200);
  });
});

// Crawler-visible product text on subpages: the stall homepage's SSR block
// (H1 shop name, about, H2 product list with prices) originally only got its
// product list from pages/stall/[slug].tsx, so scanners hitting /shop or a
// custom page still saw thin name+about content. Every subpage rendered by
// StorefrontLayout must pass the same ssrProducts summaries; blog/orders are
// exempt (they render their own SSR components and must not pay for the
// extra product query).
describe("stall subpage SSR product text", () => {
  const PRODUCT_EVENT = {
    id: "evt-chevre",
    pubkey: PUBKEY,
    created_at: 1_710_000_000,
    kind: 30402,
    content: "",
    sig: "f".repeat(128),
    tags: [
      ["d", "chevre-2024"],
      ["title", "Chèvre"],
      ["summary", "Fresh goat cheese"],
      ["price", "9", "USD"],
    ],
  };

  function prime(products: unknown[] = [PRODUCT_EVENT]) {
    fetchShopProfileByPubkeyFromDb.mockReset();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(shopEvent());
    getMembershipView.mockReset();
    getMembershipView.mockResolvedValue({ isPro: true });
    fetchProductsByPubkeyFromDb.mockReset();
    fetchProductsByPubkeyFromDb.mockResolvedValue(products);
  }

  function propsOf(res: unknown): { ssrProducts?: unknown } {
    if (!res || typeof res !== "object" || !("props" in res))
      throw new Error("expected 200 props");
    return (res as { props: { ssrProducts?: unknown } }).props;
  }

  it("passes product summaries (name, price, link) on the /shop subpage", async () => {
    prime();
    const props = propsOf(await getServerSideProps(ctx(["naughtygoatco", "shop"])));
    expect(props.ssrProducts).toEqual([
      {
        title: "Chèvre",
        priceLabel: "9.00 USD",
        url: `${SITE_URL}/listing/Chèvre`,
      },
    ]);
  });

  it("passes the same summaries on a custom page subpage", async () => {
    prime();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(shopEvent({ pages: PAGES }));
    const props = propsOf(
      await getServerSideProps(ctx(["naughtygoatco", "about"]))
    );
    expect(Array.isArray(props.ssrProducts)).toBe(true);
    expect((props.ssrProducts as unknown[]).length).toBe(1);
  });

  it("keeps product links on the seller's origin on a custom domain", async () => {
    prime();
    const props = propsOf(
      await getServerSideProps(
        ctx(["naughtygoatco", "shop"], {
          "x-ss-custom-domain-host": "NaughtyGoat.farm",
          "x-ss-original-path": "/shop",
        })
      )
    );
    const products = props.ssrProducts as { url: string }[];
    expect(products).toHaveLength(1);
    expect(products[0]!.url).toBe("https://naughtygoat.farm/listing/Chèvre");
  });

  it("still passes summaries for a non-Pro seller", async () => {
    prime();
    getMembershipView.mockResolvedValue({ isPro: false });
    const props = propsOf(await getServerSideProps(ctx(["naughtygoatco", "shop"])));
    expect((props.ssrProducts as unknown[]).length).toBe(1);
  });

  it("degrades to an empty list (not an error) when the product fetch fails", async () => {
    prime();
    fetchProductsByPubkeyFromDb.mockRejectedValue(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const props = propsOf(await getServerSideProps(ctx(["naughtygoatco", "shop"])));
    errSpy.mockRestore();
    expect(props.ssrProducts).toEqual([]);
  });

  it("does not fetch products for the blog or orders subpages", async () => {
    prime();
    await getServerSideProps(ctx(["naughtygoatco", "blog"]));
    await getServerSideProps(ctx(["naughtygoatco", "orders"]));
    expect(fetchProductsByPubkeyFromDb).not.toHaveBeenCalled();
  });
});
