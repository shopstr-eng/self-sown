/** @jest-environment node */

// SSR coverage for the newer-wins stock rule. Google and AI shopping agents
// read the JSON-LD we render on the server, so a sold-out listing must not be
// advertised as InStock. The data layer is mocked; the OG, JSON-LD and catalog
// code under test is real.

import type { GetServerSidePropsContext } from "next";
import type { NostrEvent } from "@/utils/types/types";

jest.mock("@/components/listing/product-listing-view", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/affiliate-ref-tracker", () => ({
  bindAffiliateRefToSeller: jest.fn(),
}));
jest.mock("@/components/utility-components/ss-spinner", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchProductByIdFromDb: jest.fn(),
  fetchProductByDTagAndPubkey: jest.fn(),
  fetchProductByListingSlug: jest.fn(),
  fetchProductsByPubkeyFromDb: jest.fn(),
}));
jest.mock("@/utils/db/custom-domains", () => ({
  resolveSellerCustomDomainUrl: jest.fn(async () => null),
  resolveLiveSellerCustomDomainUrl: jest.fn(async () => null),
}));
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(async () => ({ isPro: true, isHidden: false })),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  tryGetStockForProducts: jest.fn(),
}));

import {
  fetchProductByIdFromDb,
  fetchProductsByPubkeyFromDb,
} from "@/utils/db/db-service";
import { tryGetStockForProducts } from "@/utils/db/inventory-service";
import { getServerSideProps as listingGetServerSideProps } from "@/pages/listing/[[...productId]]";
import { fetchSsrStallCatalog } from "@/utils/storefront/ssr-products";

const SELLER_PUBKEY = "a".repeat(64);
const LISTED_AT = 1_710_000_000;

function makeProductEvent(id = "evt-raw-milk"): NostrEvent {
  return {
    id,
    pubkey: SELLER_PUBKEY,
    created_at: LISTED_AT,
    kind: 30402,
    content: "",
    sig: "f".repeat(128),
    tags: [
      ["d", `d-${id}`],
      ["title", `Milk ${id}`],
      ["price", "12", "USD"],
      ["quantity", "8"],
    ],
  } as NostrEvent;
}

function stockFor(id: string, quantity: number, updatedAt: number) {
  return new Map([
    [
      id,
      {
        default_quantity: quantity,
        variants: {},
        default_updated_at: updatedAt,
      },
    ],
  ]);
}

function makeContext(): GetServerSidePropsContext {
  return {
    query: { productId: ["evt-raw-milk"] },
    req: { headers: {}, url: undefined },
  } as unknown as GetServerSidePropsContext;
}

async function listingAvailability(): Promise<unknown> {
  const result = (await listingGetServerSideProps(makeContext())) as {
    props: { ogMeta: { jsonLd: Record<string, unknown>[] } };
  };
  const product = result.props.ogMeta.jsonLd.find(
    (n) => n["@type"] === "Product"
  )!;
  return (product.offers as Record<string, unknown>).availability;
}

beforeEach(() => {
  jest.clearAllMocks();
  (fetchProductByIdFromDb as jest.Mock).mockResolvedValue(makeProductEvent());
  (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
    makeProductEvent(),
  ]);
});

describe("listing page JSON-LD availability", () => {
  test("is OutOfStock when a newer stock row says zero", async () => {
    (tryGetStockForProducts as jest.Mock).mockResolvedValue(
      stockFor("evt-raw-milk", 0, LISTED_AT + 60)
    );
    expect(await listingAvailability()).toBe("https://schema.org/OutOfStock");
    expect(tryGetStockForProducts).toHaveBeenCalledWith(["evt-raw-milk"]);
  });

  test("stays InStock when the stock row is older than the listing", async () => {
    (tryGetStockForProducts as jest.Mock).mockResolvedValue(
      stockFor("evt-raw-milk", 0, LISTED_AT - 60)
    );
    expect(await listingAvailability()).toBe("https://schema.org/InStock");
  });

  test("falls back to the listing when the stock lookup returns nothing", async () => {
    (tryGetStockForProducts as jest.Mock).mockResolvedValue(new Map());
    expect(await listingAvailability()).toBe("https://schema.org/InStock");
  });
});

describe("fetchSsrStallCatalog", () => {
  test("marks only the locally sold-out product as out of stock", async () => {
    const soldOut = makeProductEvent("evt-a");
    const available = makeProductEvent("evt-b");
    (fetchProductsByPubkeyFromDb as jest.Mock).mockResolvedValue([
      soldOut,
      available,
    ]);
    (tryGetStockForProducts as jest.Mock).mockResolvedValue(
      stockFor("evt-a", 0, LISTED_AT + 1)
    );

    const { catalogProducts } = await fetchSsrStallCatalog(SELLER_PUBKEY);

    expect(tryGetStockForProducts).toHaveBeenCalledWith(["evt-a", "evt-b"]);
    expect(catalogProducts.find((p) => p.id === "evt-a")?.availability).toBe(
      "out_of_stock"
    );
    expect(catalogProducts.find((p) => p.id === "evt-b")?.availability).toBe(
      "in_stock"
    );
  });
});
