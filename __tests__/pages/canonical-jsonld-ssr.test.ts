/** @jest-environment node */

// Page-layer coverage for canonical-URL resolution in SSR. The catalog mapper
// has its own unit test for the canonicalUrl OVERRIDE; this exercises the page
// that actually RESOLVES that canonical URL from the request — the friendly
// title slug plus the seller's custom-domain origin forwarded by proxy.ts as
// `x-mm-custom-domain-host` / `x-mm-original-path`. A regression here would
// silently emit raw identifier URLs to Google / AI shopping agents even though
// the page's <link rel="canonical"> points at the friendly slug.
//
// We keep the real OG/JSON-LD/slug logic (eventToProductOgMeta, eventToUcpProduct,
// buildProductJsonLd, buildUcpCatalog, buildItemListJsonLd, getListingSlug) and
// only mock the Postgres data layer + heavy React components that the page
// modules import at load time.

import type { GetServerSidePropsContext } from "next";
import type { NostrEvent } from "@/utils/types/types";

// --- Mock the heavy React component imports so importing the page modules in a
// node env doesn't pull in HeroUI / the full storefront tree. ---
jest.mock("@/components/storefront/storefront-theme-wrapper", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/listing/product-listing-view", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/affiliate-ref-tracker", () => ({
  bindAffiliateRefToSeller: jest.fn(),
}));
jest.mock("@/components/storefront/storefront-layout", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/storefront-load-error", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/mm-spinner", () => ({
  __esModule: true,
  default: () => null,
}));

// --- Mock the Postgres data layer used by both page modules. ---
jest.mock("@/utils/db/db-service", () => ({
  fetchProductByIdFromDb: jest.fn(),
  fetchProductByDTagAndPubkey: jest.fn(),
  fetchProductByListingSlug: jest.fn(),
  fetchProductsByPubkeyFromDb: jest.fn(),
  fetchShopPubkeyBySlug: jest.fn(),
  fetchShopProfileByPubkeyFromDb: jest.fn(),
  fetchProfileByPubkeyFromDb: jest.fn(),
}));

// --- Mock the Pro membership gate so the stall page serves its Pro OG meta
// (with the catalog ItemList) without hitting the membership DB. ---
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
}));

import {
  fetchProductByIdFromDb,
  fetchProductByDTagAndPubkey,
  fetchProductByListingSlug,
  fetchProductsByPubkeyFromDb,
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
} from "@/utils/db/db-service";
import { getMembershipView } from "@/utils/pro/membership";
import { getServerSideProps as listingGetServerSideProps } from "@/pages/listing/[[...productId]]";
import { getServerSideProps as stallGetServerSideProps } from "@/pages/stall/[slug]";

const SELLER_PUBKEY = "a".repeat(64);

// The friendly slug is derived from the TITLE, which deliberately differs from
// the d-tag identifier ("raw-milk-gallon-2024"). If canonical resolution
// regressed to the raw identifier, the JSON-LD url would be
// /listing/raw-milk-gallon-2024 and these assertions would fail. titleToSlug
// preserves case (it only strips punctuation + collapses spaces to hyphens), so
// "Raw Milk" slugs to "Raw-Milk".
const PRODUCT_DTAG = "raw-milk-gallon-2024";
const FRIENDLY_SLUG = "Raw-Milk";

function makeProductEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "evt-raw-milk",
    pubkey: SELLER_PUBKEY,
    created_at: 1_710_000_000,
    kind: 30402,
    content: "",
    sig: "f".repeat(128),
    tags: [
      ["d", PRODUCT_DTAG],
      ["title", "Raw Milk"],
      ["summary", "Fresh from the farm"],
      ["price", "12", "USD"],
      ["image", "https://cdn.example/milk.jpg"],
      ["shipping", "Added Cost", "5", "USD"],
    ],
    ...overrides,
  } as NostrEvent;
}

function makeContext(
  query: Record<string, unknown>,
  headers: Record<string, string> = {}
): GetServerSidePropsContext {
  return {
    query,
    req: { headers },
  } as unknown as GetServerSidePropsContext;
}

function getProductJsonLd(ogMeta: unknown): Record<string, unknown> {
  const meta = ogMeta as { jsonLd?: Record<string, unknown>[] };
  expect(Array.isArray(meta.jsonLd)).toBe(true);
  const node = meta.jsonLd![0]!;
  expect(node["@type"]).toBe("Product");
  return node;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listing page getServerSideProps canonical JSON-LD url", () => {
  test("emits the friendly slug on the platform origin (no custom domain)", async () => {
    (fetchProductByIdFromDb as jest.Mock).mockResolvedValue(makeProductEvent());
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);

    const result = (await listingGetServerSideProps(
      makeContext({ productId: ["evt-raw-milk"] })
    )) as { props: { ogMeta: unknown } };

    const product = getProductJsonLd(result.props.ogMeta);
    expect(product.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
    const offer = product.offers as Record<string, unknown>;
    expect(offer.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
  });

  test("emits the friendly slug on the seller's custom-domain origin", async () => {
    (fetchProductByIdFromDb as jest.Mock).mockResolvedValue(makeProductEvent());
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);

    const result = (await listingGetServerSideProps(
      makeContext(
        { productId: ["evt-raw-milk"] },
        { "x-mm-custom-domain-host": "Farmer.com:443" }
      )
    )) as { props: { ogMeta: unknown } };

    const product = getProductJsonLd(result.props.ogMeta);
    // Host is lowercased and the port is stripped.
    expect(product.url).toBe(`https://farmer.com/listing/${FRIENDLY_SLUG}`);
    const offer = product.offers as Record<string, unknown>;
    expect(offer.url).toBe(`https://farmer.com/listing/${FRIENDLY_SLUG}`);
  });

  test("still uses the friendly slug when resolved via the listing-slug lookup", async () => {
    (fetchProductByIdFromDb as jest.Mock).mockResolvedValue(null);
    (fetchProductByListingSlug as jest.Mock).mockResolvedValue(
      makeProductEvent()
    );
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);

    const result = (await listingGetServerSideProps(
      makeContext({ productId: [PRODUCT_DTAG] })
    )) as { props: { ogMeta: unknown } };

    const product = getProductJsonLd(result.props.ogMeta);
    expect(product.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
  });
});

describe("stall page getServerSideProps canonical ItemList url", () => {
  const SHOP_SLUG = "happy-farm";

  function primeStall() {
    (fetchShopPubkeyBySlug as jest.Mock).mockResolvedValue(SELLER_PUBKEY);
    (getMembershipView as jest.Mock).mockResolvedValue({ isPro: true });
    (fetchShopProfileByPubkeyFromDb as jest.Mock).mockResolvedValue({
      pubkey: SELLER_PUBKEY,
      content: JSON.stringify({ name: "Happy Farm", about: "Fresh milk" }),
    });
    (fetchProfileByPubkeyFromDb as jest.Mock).mockResolvedValue(null);
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);
  }

  function getItemList(ogMeta: unknown): Record<string, unknown> {
    const meta = ogMeta as { jsonLd?: Record<string, unknown>[] };
    expect(Array.isArray(meta.jsonLd)).toBe(true);
    const node = meta.jsonLd![0]!;
    expect(node["@type"]).toBe("ItemList");
    return node;
  }

  test("ItemList + product links use the platform origin and friendly slug", async () => {
    primeStall();

    const result = (await stallGetServerSideProps(
      makeContext({ slug: SHOP_SLUG })
    )) as { props: { ogMeta: unknown } };

    const list = getItemList(result.props.ogMeta);
    expect(list.url).toBe(`https://milk.market/stall/${SHOP_SLUG}`);
    const items = list.itemListElement as Record<string, unknown>[];
    expect(items[0]!.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
  });

  test("custom domain: ItemList url is the domain root and product links stay on that origin", async () => {
    primeStall();

    const result = (await stallGetServerSideProps(
      makeContext(
        { slug: SHOP_SLUG },
        {
          "x-mm-custom-domain-host": "Farmer.com",
          "x-mm-original-path": "/",
        }
      )
    )) as { props: { ogMeta: unknown } };

    const list = getItemList(result.props.ogMeta);
    // Root path collapses to the bare origin (no trailing slash).
    expect(list.url).toBe("https://farmer.com");
    const items = list.itemListElement as Record<string, unknown>[];
    expect(items[0]!.url).toBe(`https://farmer.com/listing/${FRIENDLY_SLUG}`);
  });
});

// When a Pro seller sets their storefront to show ONE product at the root
// (landingPageMode === "product"), the stall page serves that product's OG meta
// and Product/Offer JSON-LD — but anchored to the STALL root URL, not the
// /listing/{dTag} identifier URL. A regression that emitted a /listing/... url
// here would disagree with the page's <link rel="canonical"> (the stall root),
// confusing Google / AI shopping agents about which page to index.
describe("stall page product-as-landing canonical JSON-LD url", () => {
  const SHOP_SLUG = "happy-farm";

  function primeProductLandingStall() {
    (fetchShopPubkeyBySlug as jest.Mock).mockResolvedValue(SELLER_PUBKEY);
    (getMembershipView as jest.Mock).mockResolvedValue({ isPro: true });
    (fetchShopProfileByPubkeyFromDb as jest.Mock).mockResolvedValue({
      pubkey: SELLER_PUBKEY,
      content: JSON.stringify({
        name: "Happy Farm",
        about: "Fresh milk",
        storefront: {
          landingPageMode: "product",
          landingProductDTag: PRODUCT_DTAG,
        },
      }),
    });
    (fetchProfileByPubkeyFromDb as jest.Mock).mockResolvedValue(null);
    (fetchProductByDTagAndPubkey as jest.Mock).mockResolvedValue(
      makeProductEvent()
    );
  }

  test("platform: Product + Offer urls are the stall root, not /listing/...", async () => {
    primeProductLandingStall();

    const result = (await stallGetServerSideProps(
      makeContext({ slug: SHOP_SLUG })
    )) as { props: { ogMeta: unknown } };

    const product = getProductJsonLd(result.props.ogMeta);
    expect(product.url).toBe(`https://milk.market/stall/${SHOP_SLUG}`);
    const offer = product.offers as Record<string, unknown>;
    expect(offer.url).toBe(`https://milk.market/stall/${SHOP_SLUG}`);
    // The product d-tag must NOT leak into the canonical URL.
    expect(product.url).not.toContain(`/listing/${PRODUCT_DTAG}`);
    expect(product.url).not.toContain(`/listing/${FRIENDLY_SLUG}`);
  });

  test("custom domain: Product + Offer urls are the bare domain origin", async () => {
    primeProductLandingStall();

    const result = (await stallGetServerSideProps(
      makeContext(
        { slug: SHOP_SLUG },
        {
          "x-mm-custom-domain-host": "Farmer.com",
          "x-mm-original-path": "/",
        }
      )
    )) as { props: { ogMeta: unknown } };

    const product = getProductJsonLd(result.props.ogMeta);
    // Root path collapses to the bare origin (host lowercased, no trailing slash).
    expect(product.url).toBe("https://farmer.com");
    const offer = product.offers as Record<string, unknown>;
    expect(offer.url).toBe("https://farmer.com");
    expect(product.url).not.toContain("/listing/");
  });
});

// If the pinned landing product is deleted/unpublished (the d-tag fetch resolves
// null) — or the fetch throws — the stall page must NOT serve empty/Product OG
// meta or crash; it must fall THROUGH to the normal catalog ItemList branch so
// the storefront still emits structured data anchored to the stall root URL.
describe("stall page product-as-landing fallback to catalog ItemList", () => {
  const SHOP_SLUG = "happy-farm";

  // Same product-as-landing storefront config as the happy path, but the caller
  // controls how fetchProductByDTagAndPubkey behaves and we ALSO prime the
  // catalog fetch the fallback branch depends on.
  function primeMissingLandingProduct() {
    (fetchShopPubkeyBySlug as jest.Mock).mockResolvedValue(SELLER_PUBKEY);
    (getMembershipView as jest.Mock).mockResolvedValue({ isPro: true });
    (fetchShopProfileByPubkeyFromDb as jest.Mock).mockResolvedValue({
      pubkey: SELLER_PUBKEY,
      content: JSON.stringify({
        name: "Happy Farm",
        about: "Fresh milk",
        storefront: {
          landingPageMode: "product",
          landingProductDTag: PRODUCT_DTAG,
        },
      }),
    });
    (fetchProfileByPubkeyFromDb as jest.Mock).mockResolvedValue(null);
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);
  }

  function getItemList(ogMeta: unknown): Record<string, unknown> {
    const meta = ogMeta as { jsonLd?: Record<string, unknown>[] };
    expect(Array.isArray(meta.jsonLd)).toBe(true);
    const node = meta.jsonLd![0]!;
    expect(node["@type"]).toBe("ItemList");
    return node;
  }

  test("deleted landing product (fetch resolves null) falls back to catalog ItemList", async () => {
    primeMissingLandingProduct();
    (fetchProductByDTagAndPubkey as jest.Mock).mockResolvedValue(null);

    const result = (await stallGetServerSideProps(
      makeContext({ slug: SHOP_SLUG })
    )) as { props: { ogMeta: unknown } };

    // It must be the catalog ItemList, NOT Product JSON-LD or default OG meta.
    const list = getItemList(result.props.ogMeta);
    expect(list.url).toBe(`https://milk.market/stall/${SHOP_SLUG}`);
    const items = list.itemListElement as Record<string, unknown>[];
    expect(items[0]!.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
  });

  test("landing product fetch throwing falls back to catalog ItemList", async () => {
    primeMissingLandingProduct();
    (fetchProductByDTagAndPubkey as jest.Mock).mockRejectedValue(
      new Error("relay/db unavailable")
    );

    const result = (await stallGetServerSideProps(
      makeContext({ slug: SHOP_SLUG })
    )) as { props: { ogMeta: unknown } };

    const list = getItemList(result.props.ogMeta);
    expect(list.url).toBe(`https://milk.market/stall/${SHOP_SLUG}`);
    const items = list.itemListElement as Record<string, unknown>[];
    expect(items[0]!.url).toBe(`https://milk.market/listing/${FRIENDLY_SLUG}`);
  });
});

// Custom storefront OG meta — including the product-as-landing Product JSON-LD —
// is a Pro-only feature gated by `if (shopEvent && membership.isPro)`. A lapsed
// or never-Pro seller (getMembershipView → { isPro: false }) must NEVER have
// their pinned product override the shop preview: the page must serve the
// DEFAULT stall OG meta with NO Product/ItemList structured data. A regression
// that dropped the isPro gate would leak a premium feature to crawlers / AI
// shopping agents AND emit the wrong canonical structured data for the stall.
describe("stall page non-Pro seller never serves product-as-landing OG meta", () => {
  const SHOP_SLUG = "happy-farm";

  // Same product-as-landing storefront config as the Pro happy path, but the
  // seller is NOT Pro. We also prime the d-tag + catalog fetches so that if the
  // Pro branch were (wrongly) entered, the test would observe Product/ItemList
  // JSON-LD instead of the default meta — i.e. the assertions catch a dropped
  // gate, not merely a missing fixture.
  function primeNonProProductLandingStall() {
    (fetchShopPubkeyBySlug as jest.Mock).mockResolvedValue(SELLER_PUBKEY);
    (getMembershipView as jest.Mock).mockResolvedValue({ isPro: false });
    (fetchShopProfileByPubkeyFromDb as jest.Mock).mockResolvedValue({
      pubkey: SELLER_PUBKEY,
      content: JSON.stringify({
        name: "Happy Farm",
        about: "Fresh milk",
        storefront: {
          landingPageMode: "product",
          landingProductDTag: PRODUCT_DTAG,
        },
      }),
    });
    (fetchProfileByPubkeyFromDb as jest.Mock).mockResolvedValue(null);
    (fetchProductByDTagAndPubkey as jest.Mock).mockResolvedValue(
      makeProductEvent()
    );
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      makeProductEvent(),
    ]);
  }

  test("serves the default stall OG meta with no Product/ItemList JSON-LD", async () => {
    primeNonProProductLandingStall();

    const result = (await stallGetServerSideProps(
      makeContext({ slug: SHOP_SLUG })
    )) as { props: { ogMeta: { title?: string; jsonLd?: unknown } } };

    const { ogMeta } = result.props;
    // Default stall meta, NOT the pinned product's title/description.
    expect(ogMeta.title).toBe("Milk Market Stall");
    // No structured data at all — neither Product nor ItemList JSON-LD.
    expect(ogMeta.jsonLd).toBeUndefined();
  });

  test("never fetches the pinned landing product when the seller is not Pro", async () => {
    primeNonProProductLandingStall();

    await stallGetServerSideProps(makeContext({ slug: SHOP_SLUG }));

    // The product-as-landing branch lives behind the isPro gate, so a non-Pro
    // seller must short-circuit before any pinned-product lookup happens.
    expect(fetchProductByDTagAndPubkey).not.toHaveBeenCalled();
  });
});
