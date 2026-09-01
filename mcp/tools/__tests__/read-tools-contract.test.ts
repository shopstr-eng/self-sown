import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "@/mcp/tools/read-tools";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";

jest.mock("@/utils/db/db-service", () => ({
  fetchAllProductsFromDb: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  fetchCachedEvents: jest.fn(),
  validateDiscountCode: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  getDbPool: jest.fn(),
  fetchCommentsByReviewIds: jest.fn(),
}));

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (args: Record<string, unknown>) => Promise<Result>;

const pubkey = "a".repeat(64);
const product = (
  id: string,
  createdAt: number,
  d = id,
  tags: string[][] = []
) => ({
  id,
  pubkey,
  kind: 30402,
  created_at: createdAt,
  content: "x".repeat(20_000),
  tags: [["d", d], ["title", id], ...tags],
});

function tools() {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn(
      (name: string, _options: unknown, callback: Callback) =>
        callbacks.set(name, callback)
    ),
  };
  registerReadTools(server as unknown as McpServer);
  return callbacks;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

describe("MCP read-tool safety contracts", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deduplicates replaceable listings and advances a monotonic cursor", async () => {
    jest
      .mocked(fetchAllProductsFromDb)
      .mockResolvedValue([
        product("old", 10, "listing"),
        product("new", 20, "listing"),
        product("next", 10, "next"),
      ] as any);
    const search = tools().get("search_products")!;

    const first = payload(await search({ limit: 1 }));
    expect(first.products.map((item: { id: string }) => item.id)).toEqual([
      "new",
    ]);
    expect(first._pagination.hasMore).toBe(true);

    const second = payload(
      await search({ limit: 1, cursor: first._pagination.nextCursor })
    );
    expect(second.products.map((item: { id: string }) => item.id)).toEqual([
      "next",
    ]);
    expect(second._pagination.nextCursor).toBeNull();
  });

  it("continues through more than 128 same-timestamp listings without repeats", async () => {
    let events = Array.from({ length: 130 }, (_, index) =>
      product(`listing-${String(index).padStart(3, "0")}`, 20)
    );
    jest
      .mocked(fetchAllProductsFromDb)
      .mockImplementation(async () => events as any);
    const search = tools().get("search_products")!;

    let page = payload(await search({ limit: 50 }));
    const returned = page.products.map((item: { id: string }) => item.id);
    // This new listing sorts immediately after the first page's continuation
    // tuple. It must be returned exactly once rather than causing a loop.
    events = [...events, product("listing-049a", 20)];

    while (page._pagination.nextCursor) {
      page = payload(
        await search({ limit: 50, cursor: page._pagination.nextCursor })
      );
      returned.push(...page.products.map((item: { id: string }) => item.id));
    }

    expect(returned).toHaveLength(131);
    expect(new Set(returned).size).toBe(131);
    expect(returned).toContain("listing-049a");
  });

  it("rejects cursor reuse with changed filters and bounds untrusted content", async () => {
    jest
      .mocked(fetchAllProductsFromDb)
      .mockResolvedValue([product("one", 20), product("two", 10)] as any);
    const registered = tools();
    const search = registered.get("search_products")!;
    const first = payload(await search({ limit: 1 }));
    const rejected = await search({
      limit: 1,
      keyword: "two",
      cursor: first._pagination.nextCursor,
    });
    expect(rejected.isError).toBe(true);

    const details = payload(
      await registered.get("get_product_details")!({ productId: "one" })
    );
    expect(details.content).toHaveLength(16_000);
    expect(details.contentTruncated).toBe(true);
  });

  it("normalizes category discovery and ignores unsafe category tags", async () => {
    jest.mocked(fetchAllProductsFromDb).mockResolvedValue([
      product("one", 20, "one", [
        ["t", " Fresh   Milk "],
        ["t", "\u0000bad"],
      ]),
      product("two", 10, "two", [["t", "fresh milk"]]),
    ] as any);
    const categories = payload(await tools().get("get_categories")!({}));
    expect(categories.categories).toEqual([{ name: "fresh milk", count: 2 }]);
  });
});