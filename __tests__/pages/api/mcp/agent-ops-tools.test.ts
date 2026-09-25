/** @jest-environment node */

/**
 * Contract tests for the agent seller-ops tools: get_shipping_label_status
 * (pages/api/mcp/index.ts), purchase_shipping_label, send_test_email, and
 * send_broadcast_email (mcp/tools/write-tools.ts).
 *
 * Drives the tools through the real MCP SDK (registerPurchaseTools +
 * registerWriteTools on a live McpServer + InMemoryTransport) so zod schema
 * validation and permission gates actually execute. The email/broadcast
 * service, the label purchase routine, and the DB query are mocked at their
 * module seams — what is pinned here is TOOL behavior: permission gating,
 * seller scoping, schema bounds, and outcome mapping.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// db-service is called at module scope by real utils/db/* modules; a mock
// without getDbPool kills the whole suite at import time.
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  fetchAllProductsFromDb: jest.fn(async () => []),
  fetchAllProfilesFromDb: jest.fn(async () => []),
  fetchCachedEvents: jest.fn(async () => []),
  fetchCommentsByReviewIds: jest.fn(async () => []),
  validateDiscountCode: jest.fn(),
  getStripeConnectAccount: jest.fn(),
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
  getDbPool: jest.fn(),
  markMessagesAsRead: jest.fn(),
  getUnreadMessageCount: jest.fn(async () => 0),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
  getRequestIp: jest.fn(() => "127.0.0.1"),
}));

jest.mock("@/utils/mcp/metrics", () => ({ recordRequest: jest.fn() }));

const mockGetAgentSigner: jest.Mock = jest.fn(async () => null);
jest.mock("@/utils/mcp/auth", () => ({
  extractBearerToken: jest.fn(),
  validateApiKey: jest.fn(),
  initializeApiKeysTable: jest.fn(),
  isApiKeyOwnerProEntitled: jest.fn(async () => true),
  MCP_PRO_REQUIRED_MESSAGE: "Pro required",
  getAgentSigner: (...args: unknown[]) => mockGetAgentSigner(...args),
}));

const mockIsPubkeyProEntitled: jest.Mock = jest.fn(async () => true);
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
  isPubkeyProEntitled: () => mockIsPubkeyProEntitled(),
}));

jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));

const mockGetMcpOrder: jest.Mock = jest.fn();
jest.mock("@/mcp/tools/purchase-tools", () => ({
  listMcpOrders: jest.fn(async () => []),
  listMcpOrdersAsSeller: jest.fn(async () => []),
  formatOrderForResponse: (o: unknown) => o,
  getMcpOrder: (...args: unknown[]) => mockGetMcpOrder(...args),
}));

const mockListLabelStatuses: jest.Mock = jest.fn(async () => []);
jest.mock("@/utils/db/shipping-service", () => ({
  listSellerOrderLabelStatuses: (...args: unknown[]) =>
    mockListLabelStatuses(...args),
}));

const mockAutoPurchase: jest.Mock = jest.fn();
jest.mock("@/utils/shipping/auto-purchase", () => ({
  autoPurchaseForMcpOrder: (...args: unknown[]) => mockAutoPurchase(...args),
}));

const mockRunOneTimeBroadcast: jest.Mock = jest.fn();
const mockSendOneTimeTestEmail: jest.Mock = jest.fn();
jest.mock("@/utils/email/one-time-broadcast", () => ({
  runOneTimeBroadcast: (...args: unknown[]) => mockRunOneTimeBroadcast(...args),
  sendOneTimeTestEmail: (...args: unknown[]) =>
    mockSendOneTimeTestEmail(...args),
}));

import { registerPurchaseTools } from "@/pages/api/mcp/index";
import { registerWriteTools } from "@/mcp/tools/write-tools";

const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);
const FULL_KEY = { id: 1, pubkey: PUBKEY, permissions: "full_access" } as never;
const READ_WRITE_KEY = {
  id: 2,
  pubkey: PUBKEY,
  permissions: "read_write",
} as never;

async function makeClient(apiKey = FULL_KEY): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerPurchaseTools(server, apiKey, "token");
  registerWriteTools(server, apiKey);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

// The tools return JSON text content; isError marks failures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

let client: Client;
let readWriteClient: Client;

beforeAll(async () => {
  client = await makeClient();
  readWriteClient = await makeClient(READ_WRITE_KEY);
});

afterAll(async () => {
  await client.close();
  await readWriteClient.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a signer is available (happy path), owner is Pro.
  mockGetAgentSigner.mockResolvedValue({
    signer: { getPubKey: () => PUBKEY },
  });
  mockIsPubkeyProEntitled.mockResolvedValue(true);
});

describe("get_shipping_label_status", () => {
  it.each([
    ["limit of zero", { limit: 0 }],
    ["limit above the 100 cap", { limit: 101 }],
    ["fractional limit", { limit: 2.5 }],
    ["negative offset", { offset: -1 }],
  ])("rejects %s before querying", async (_label, args) => {
    const result = await client.callTool({
      name: "get_shipping_label_status",
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(mockListLabelStatuses).not.toHaveBeenCalled();
  });

  it("queries with the API key's own pubkey and maps label state", async () => {
    mockListLabelStatuses.mockResolvedValue([
      {
        order_id: "ord_1",
        product_title: "Raw cheddar",
        quantity: 2,
        payment_status: "paid",
        order_status: "confirmed",
        created_at: "2026-09-01",
        has_shipping_address: true,
        label_id: 7,
        tracking_code: "9400",
        tracking_url: "https://track",
        label_url: "https://label",
        carrier: "USPS",
        service: "Ground Advantage",
        rate_usd: "7.25",
        purchased_at: "2026-09-02",
      },
      {
        order_id: "ord_2",
        product_title: "Sourdough",
        quantity: 1,
        payment_status: "paid",
        order_status: "pending",
        created_at: "2026-09-03",
        has_shipping_address: true,
        label_id: null,
        tracking_code: null,
        tracking_url: null,
        label_url: null,
        carrier: null,
        service: null,
        rate_usd: null,
        purchased_at: null,
      },
    ]);
    const result = await client.callTool({
      name: "get_shipping_label_status",
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    expect(mockListLabelStatuses).toHaveBeenCalledWith(PUBKEY, {
      orderId: undefined,
      limit: 50,
      offset: 0,
    });
    const parsed = parseResult(result);
    expect(parsed.orders[0].labelStatus).toBe("purchased");
    expect(parsed.orders[0].label.trackingCode).toBe("9400");
    expect(parsed.orders[1].labelStatus).toBe("not_purchased");
    expect(parsed.orders[1].label).toBeNull();
  });

  it("passes a single-order lookup through with the key's pubkey", async () => {
    await client.callTool({
      name: "get_shipping_label_status",
      arguments: { order_id: "ord_9" },
    });
    expect(mockListLabelStatuses).toHaveBeenCalledWith(
      PUBKEY,
      expect.objectContaining({ orderId: "ord_9" })
    );
  });
});

describe("purchase_shipping_label", () => {
  it("requires full_access", async () => {
    const result = await readWriteClient.callTool({
      name: "purchase_shipping_label",
      arguments: { order_id: "ord_1" },
    });
    expect(result.isError).toBe(true);
    expect(mockAutoPurchase).not.toHaveBeenCalled();
  });

  it("returns not-found for another seller's order and never buys", async () => {
    mockGetMcpOrder.mockResolvedValue({
      order_id: "ord_1",
      seller_pubkey: OTHER_PUBKEY,
      payment_status: "paid",
    });
    const result = await client.callTool({
      name: "purchase_shipping_label",
      arguments: { order_id: "ord_1" },
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toBe("Order not found");
    expect(mockAutoPurchase).not.toHaveBeenCalled();
  });

  it("buys the label for the seller's own order (deliberate trigger bypasses the auto toggle)", async () => {
    mockGetMcpOrder.mockResolvedValue({
      order_id: "ord_1",
      seller_pubkey: PUBKEY,
      payment_status: "paid",
    });
    mockAutoPurchase.mockResolvedValue({
      purchased: true,
      labelId: 42,
      label: {
        trackingCode: "9400",
        trackingUrl: "https://tools.usps.com/go/9400",
        labelUrl: "https://shippo.test/label.pdf",
        labelFormat: "PDF",
        rate: 8.25,
        currency: "USD",
        carrier: "USPS",
        service: "Ground Advantage",
      },
    });
    const result = await client.callTool({
      name: "purchase_shipping_label",
      arguments: { order_id: "ord_1" },
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.purchased).toBe(true);
    expect(parsed.label).toEqual(
      expect.objectContaining({
        trackingCode: "9400",
        labelUrl: "https://shippo.test/label.pdf",
        rate: 8.25,
        carrier: "USPS",
      })
    );
    expect(mockAutoPurchase).toHaveBeenCalledWith("ord_1", {
      bypassAutoToggle: true,
    });
  });

  it("reports already-bought instead of double-buying", async () => {
    mockGetMcpOrder.mockResolvedValue({
      order_id: "ord_1",
      seller_pubkey: PUBKEY,
      payment_status: "paid",
    });
    mockAutoPurchase.mockResolvedValue({
      purchased: false,
      reason: "already-bought",
    });
    const result = await client.callTool({
      name: "purchase_shipping_label",
      arguments: { order_id: "ord_1" },
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).details).toMatch(
      /already has a shipping label/i
    );
  });
});

describe("send_test_email", () => {
  it("sends a [TEST] email for the key owner", async () => {
    mockSendOneTimeTestEmail.mockResolvedValue({ ok: true });
    const result = await client.callTool({
      name: "send_test_email",
      arguments: {
        target_email: "me@example.com",
        subject: "Preview",
        body_html: "<p>Hi {{shop_name}}</p>",
      },
    });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result).sent).toBe(true);
    expect(mockSendOneTimeTestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: PUBKEY, to: "me@example.com" })
    );
  });

  it("surfaces an invalid address instead of sending", async () => {
    mockSendOneTimeTestEmail.mockResolvedValue({
      ok: false,
      error: "Invalid target_email",
    });
    const result = await client.callTool({
      name: "send_test_email",
      arguments: {
        target_email: "not-an-email",
        subject: "Preview",
        body_html: "<p>x</p>",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects a blank subject at the schema", async () => {
    const result = await client.callTool({
      name: "send_test_email",
      arguments: {
        target_email: "me@example.com",
        subject: "",
        body_html: "<p>x</p>",
      },
    });
    expect(result.isError).toBe(true);
    expect(mockSendOneTimeTestEmail).not.toHaveBeenCalled();
  });
});

describe("send_broadcast_email", () => {
  const validArgs = {
    subject: "Fresh eggs Saturday",
    body_html: "<p>We will have eggs at the market.</p>",
  };

  it("requires full_access", async () => {
    const result = await readWriteClient.callTool({
      name: "send_broadcast_email",
      arguments: validArgs,
    });
    expect(result.isError).toBe(true);
    expect(mockRunOneTimeBroadcast).not.toHaveBeenCalled();
  });

  it("requires an active Herd membership", async () => {
    mockIsPubkeyProEntitled.mockResolvedValue(false);
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: validArgs,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/Herd/);
    expect(mockRunOneTimeBroadcast).not.toHaveBeenCalled();
  });

  it("reports sent counts on success", async () => {
    mockRunOneTimeBroadcast.mockResolvedValue({
      kind: "sent",
      sent: 5,
      failed: 0,
      total: 5,
    });
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: validArgs,
    });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      status: "sent",
      sent: 5,
      total: 5,
    });
    expect(mockRunOneTimeBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: PUBKEY, subject: validArgs.subject })
    );
  });

  it("treats a replayed idempotency key as already_sent, not an error", async () => {
    mockRunOneTimeBroadcast.mockResolvedValue({ kind: "already-sent" });
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: { ...validArgs, idempotency_key: "launch-2026-09" },
    });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result).status).toBe("already_sent");
  });

  it("rejects an idempotency key reused with different content", async () => {
    mockRunOneTimeBroadcast.mockResolvedValue({ kind: "key-mismatch" });
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: { ...validArgs, idempotency_key: "launch-2026-09" },
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).details).toMatch(/different content/);
  });

  it("fails closed when the seller has no verified sender domain", async () => {
    mockRunOneTimeBroadcast.mockResolvedValue({ kind: "no-sender" });
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: validArgs,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).details).toMatch(
      /verified custom sender domain/
    );
  });

  it("rejects idempotency keys with unsafe characters at the schema", async () => {
    const result = await client.callTool({
      name: "send_broadcast_email",
      arguments: { ...validArgs, idempotency_key: "bad key!" },
    });
    expect(result.isError).toBe(true);
    expect(mockRunOneTimeBroadcast).not.toHaveBeenCalled();
  });
});
