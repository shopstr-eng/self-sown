/** @jest-environment node */

// /api/ucp/catalog/search must agree with /api/ucp/catalog/lookup on
// availability. Both apply the newer-wins stock rule, so the `availability`
// filter has to see local stock rows and not just the listing's own tags.

import type { NextApiRequest, NextApiResponse } from "next";
import type { NostrEvent } from "@/utils/types/types";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));
jest.mock("@/utils/site-url", () => ({
  getSiteUrl: () => "https://self-sown.com",
  SITE_URL: "https://self-sown.com",
}));
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: jest.fn(),
  fetchProductsByPubkeyFromDb: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  tryGetStockForProducts: jest.fn(),
}));
jest.mock("@/utils/ucp/seller-host", () => ({
  deriveBaseUrl: () => "https://self-sown.com",
  resolveHostScope: jest.fn(async () => ({
    scope: "marketplace",
    seller: null,
    unresolved: false,
  })),
  fetchSellerNames: jest.fn(async () => new Map()),
}));

import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import { tryGetStockForProducts } from "@/utils/db/inventory-service";
import handler from "@/pages/api/ucp/catalog/search";

const LISTED_AT = 1_710_000_000;

function makeEvent(id: string, title: string): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: LISTED_AT,
    kind: 30402,
    content: "",
    sig: "f".repeat(128),
    tags: [
      ["d", `d-${id}`],
      ["title", title],
      ["price", "5", "USD"],
      ["quantity", "6"],
    ],
  } as NostrEvent;
}

function mockRes() {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    end: jest.fn(),
  };
  return res as unknown as NextApiResponse & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

async function search(query: Record<string, string>) {
  const req = {
    method: "GET",
    headers: { host: "self-sown.com" },
    query,
    socket: {},
  } as unknown as NextApiRequest;
  const res = mockRes();
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.json.mock.calls[0][0].products as { id: string }[];
}

beforeEach(() => {
  jest.clearAllMocks();
  (fetchAllProductsFromDb as jest.Mock).mockResolvedValue([
    makeEvent("evt-sold-out", "Sold out cheese"),
    makeEvent("evt-fresh", "Fresh cheese"),
  ]);
  (tryGetStockForProducts as jest.Mock).mockResolvedValue(
    new Map([
      [
        "evt-sold-out",
        {
          default_quantity: 0,
          variants: {},
          default_updated_at: LISTED_AT + 30,
        },
      ],
    ])
  );
});

describe("UCP catalog search availability", () => {
  test("loads local stock for the scanned listings in one call", async () => {
    await search({});
    expect(tryGetStockForProducts).toHaveBeenCalledTimes(1);
    expect(tryGetStockForProducts).toHaveBeenCalledWith([
      "evt-sold-out",
      "evt-fresh",
    ]);
  });

  test("out_of_stock returns the locally sold-out listing", async () => {
    const products = await search({ availability: "out_of_stock" });
    expect(products.map((p) => p.id)).toEqual(["evt-sold-out"]);
  });

  test("in_stock leaves the sold-out listing out", async () => {
    const products = await search({ availability: "in_stock" });
    expect(products.map((p) => p.id)).toEqual(["evt-fresh"]);
  });

  test("uses the listing's own quantity when local stock is unavailable", async () => {
    (tryGetStockForProducts as jest.Mock).mockResolvedValue(new Map());
    const products = await search({ availability: "in_stock" });
    expect(products.map((p) => p.id).sort()).toEqual([
      "evt-fresh",
      "evt-sold-out",
    ]);
  });
});
