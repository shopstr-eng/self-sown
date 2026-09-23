/** @jest-environment node */

/**
 * Pagination bounds pin for the order-listing MCP tools in
 * pages/api/mcp/index.ts (list_orders, list_seller_orders, and
 * get_notifications' orderLimit).
 *
 * The sibling REST list route (handleListOrders in create-order.ts) clamps
 * limit to 1-100 and offset to >= 0, but these tools take pagination straight
 * from the agent. A bare z.number() schema accepts limit=1000000000 (one call
 * scans/serializes the whole mcp_orders table) or offset=-5 (meaningless
 * input). The schemas must reject out-of-range/fractional values BEFORE the
 * tool callback runs — this drives the tools through the real MCP SDK
 * (registerPurchaseTools on a live McpServer + InMemoryTransport) so the
 * validation actually executes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// db-service is called at module scope by real utils/db/* modules; a mock
// without getDbPool kills the whole suite at import time.
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  fetchAllProductsFromDb: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  fetchCachedEvents: jest.fn(),
  fetchCommentsByReviewIds: jest.fn(),
  fetchAllMessagesFromDb: jest.fn(),
  createEmailFlow: jest.fn(),
  getEmailFlows: jest.fn(),
  getEmailFlow: jest.fn(),
  updateEmailFlow: jest.fn(),
  deleteEmailFlow: jest.fn(),
  createFlowStep: jest.fn(),
  getFlowSteps: jest.fn(),
  updateFlowStep: jest.fn(),
  deleteFlowStep: jest.fn(),
  getFlowEnrollments: jest.fn(),
  getSubscriptionsBySellerPubkey: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  validateDiscountCode: jest.fn(),
  getDbPool: jest.fn(),
  markMessagesAsRead: jest.fn(),
  getUnreadMessageCount: jest.fn(async () => 0),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
  getRequestIp: jest.fn(() => "127.0.0.1"),
}));

jest.mock("@/utils/mcp/auth", () => ({
  extractBearerToken: jest.fn(),
  validateApiKey: jest.fn(),
  initializeApiKeysTable: jest.fn(),
  isApiKeyOwnerProEntitled: jest.fn(async () => true),
  MCP_PRO_REQUIRED_MESSAGE: "Pro required",
  getAgentSigner: jest.fn(),
}));

jest.mock("@/utils/mcp/metrics", () => ({ recordRequest: jest.fn() }));

const mockListMcpOrders = jest.fn(async (..._args: any[]) => [] as any[]);
const mockListMcpOrdersAsSeller = jest.fn(
  async (..._args: any[]) => [] as any[]
);
const mockFormatOrderForResponse = jest.fn((o: unknown) => o);

jest.mock("@/mcp/tools/purchase-tools", () => ({
  listMcpOrders: (...args: any[]) => mockListMcpOrders(...args),
  listMcpOrdersAsSeller: (...args: any[]) => mockListMcpOrdersAsSeller(...args),
  formatOrderForResponse: (o: unknown) => mockFormatOrderForResponse(o),
}));

import { registerPurchaseTools } from "@/pages/api/mcp/index";

const PUBKEY = "a".repeat(64);
const API_KEY = { id: 1, pubkey: PUBKEY, permissions: "read_write" } as any;

async function makeClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerPurchaseTools(server, API_KEY, "token");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("MCP order-listing pagination bounds", () => {
  let client: Client;

  beforeAll(async () => {
    // list_orders forwards to the REST route over HTTP; stub fetch for the
    // in-range cases that reach the callback.
    (global as any).fetch = jest.fn(async () => ({
      json: async () => ({ success: true, orders: [] }),
    }));
    client = await makeClient();
  });

  beforeEach(() => {
    mockListMcpOrders.mockClear();
    mockListMcpOrdersAsSeller.mockClear();
    (global.fetch as jest.Mock).mockClear();
  });

  afterAll(async () => {
    await client.close();
  });

  it.each([
    ["limit above the 100 cap", { limit: 1000000000 }],
    ["limit of zero", { limit: 0 }],
    ["fractional limit", { limit: 2.5 }],
    ["negative offset", { limit: 10, offset: -5 }],
    ["fractional offset", { offset: 1.5 }],
  ])("list_orders rejects %s before listing anything", async (_label, args) => {
    // The SDK turns schema validation failures into an isError tool result
    // (MCP error -32602), not a rejected promise.
    const result: any = await client.callTool({
      name: "list_orders",
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/-32602|Invalid/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("list_orders accepts the in-range boundary values", async () => {
    const result = await client.callTool({
      name: "list_orders",
      arguments: { limit: 100, offset: 0 },
    });
    expect(result.isError).toBeFalsy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=100&offset=0"),
      expect.anything()
    );
  });

  it.each([
    ["limit above the 100 cap", { limit: 101 }],
    ["negative offset", { offset: -1 }],
    ["fractional limit", { limit: 10.5 }],
  ])(
    "list_seller_orders rejects %s before querying",
    async (_label, args) => {
      const result: any = await client.callTool({
        name: "list_seller_orders",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/-32602|Invalid/i);
      expect(mockListMcpOrdersAsSeller).not.toHaveBeenCalled();
    }
  );

  it("list_seller_orders passes in-range pagination through", async () => {
    const result = await client.callTool({
      name: "list_seller_orders",
      arguments: { limit: 50, offset: 5 },
    });
    expect(result.isError).toBeFalsy();
    expect(mockListMcpOrdersAsSeller).toHaveBeenCalledWith(PUBKEY, 50, 5);
  });

  it.each([
    ["orderLimit above the cap", { orderLimit: 1000000000 }],
    ["orderLimit of zero", { orderLimit: 0 }],
    ["fractional orderLimit", { orderLimit: 3.7 }],
  ])(
    "get_notifications rejects %s before querying",
    async (_label, args) => {
      const result: any = await client.callTool({
        name: "get_notifications",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/-32602|Invalid/i);
      expect(mockListMcpOrders).not.toHaveBeenCalled();
    }
  );

  it("get_notifications accepts an in-range orderLimit", async () => {
    const result = await client.callTool({
      name: "get_notifications",
      arguments: { orderLimit: 100 },
    });
    expect(result.isError).toBeFalsy();
    expect(mockListMcpOrders).toHaveBeenCalledWith(PUBKEY, 100);
  });

  it.each([
    ["quantity of zero", { quantity: 0 }],
    ["negative quantity", { quantity: -3 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["quantity above the 10000 cap", { quantity: 10001 }],
    ["absurd quantity", { quantity: 1000000000 }],
    ["selectedBulkUnits of zero", { selectedBulkUnits: 0 }],
    ["fractional selectedBulkUnits", { selectedBulkUnits: 2.5 }],
    ["selectedBulkUnits above the 100000 cap", { selectedBulkUnits: 100001 }],
    ["absurd selectedBulkUnits", { selectedBulkUnits: 1000000000 }],
  ])("create_order rejects %s before creating anything", async (_label, args) => {
    const result: any = await client.callTool({
      name: "create_order",
      arguments: { productId: "prod-1", ...args },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/-32602|Invalid/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("create_order accepts the in-range boundary values", async () => {
    const result = await client.callTool({
      name: "create_order",
      arguments: { productId: "prod-1", quantity: 10000, selectedBulkUnits: 1 },
    });
    expect(result.isError).toBeFalsy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/mcp/create-order"),
      expect.objectContaining({
        body: expect.stringContaining('"quantity":10000'),
      })
    );
  });
});
