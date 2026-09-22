import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "@/mcp/tools/read-tools";
import { registerWriteTools } from "@/mcp/tools/write-tools";
import {
  fetchAllMessagesFromDb,
  getSubscriptionsBySellerPubkey,
  getEmailFlow,
  getFlowEnrollments,
  getFlowSteps,
  fetchCachedEvents,
  getDbPool,
} from "@/utils/db/db-service";
import { getMembershipView } from "@/utils/pro/membership";
import {
  getMcpOrder,
  listMcpOrders,
  listMcpOrdersAsSeller,
  updateMcpOrderStatus,
  updateMcpOrderAddress,
} from "@/mcp/tools/purchase-tools";

// db-service is called at module scope by utils/db/* (getDbPool), so the
// factory must provide every export the tool modules import, not just the
// ones this test drives.
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
}));

jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
}));

const ownerPubkey = "b".repeat(64);

jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: jest.fn(async () => ({
    signer: {
      getPubKey: () => ownerPubkey,
      // Identity decrypt: lets get_cashu_balance parse mocked proof content.
      decrypt: (_pk: string, content: string) => content,
    },
    pubkey: ownerPubkey,
  })),
}));

jest.mock("@/utils/mcp/nostr-signing", () => ({
  McpNostrSigner: jest.fn(),
  McpRelayManager: jest.fn(),
  signAndPublishEvent: jest.fn(),
}));

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<Result>;

function writeTools(permissions: "full_access" | "read_only" = "full_access") {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn(
      (name: string, _options: unknown, callback: Callback) =>
        callbacks.set(name, callback)
    ),
  };
  registerWriteTools(server as unknown as McpServer, {
    id: 1,
    pubkey: ownerPubkey,
    permissions,
  } as any);
  return callbacks;
}

function readTools(context?: { apiKeyId: number; pubkey: string }) {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn(
      (name: string, _options: unknown, callback: Callback) =>
        callbacks.set(name, callback)
    ),
  };
  registerReadTools(server as unknown as McpServer, context);
  return callbacks;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

const otherPubkey = "c".repeat(64);

describe("read-tool owner scoping", () => {
  beforeEach(() => jest.clearAllMocks());

  it("list_messages fetches only the key owner's messages", async () => {
    jest.mocked(fetchAllMessagesFromDb).mockResolvedValue([]);
    const cb = writeTools().get("list_messages")!;

    const result = await cb({});

    expect(jest.mocked(fetchAllMessagesFromDb)).toHaveBeenCalledWith(
      ownerPubkey
    );
    expect(result.isError).toBeFalsy();
    expect(payload(result).messages).toEqual([]);
  });

  it("list_seller_subscriptions queries by the key owner's pubkey", async () => {
    jest.mocked(getSubscriptionsBySellerPubkey).mockResolvedValue([]);
    const cb = writeTools().get("list_seller_subscriptions")!;

    const result = await cb({});

    expect(jest.mocked(getSubscriptionsBySellerPubkey)).toHaveBeenCalledWith(
      ownerPubkey
    );
    expect(payload(result).subscriptions).toEqual([]);
  });

  it("get_email_flow_stats refuses a flow owned by another seller", async () => {
    jest.mocked(getEmailFlow).mockResolvedValue({
      id: 7,
      seller_pubkey: otherPubkey,
      name: "theirs",
    } as any);
    const cb = writeTools().get("get_email_flow_stats")!;

    const result = await cb({ flow_id: 7 });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe("Not authorized");
    // No enrollment/step data for the other seller's flow may be read.
    expect(jest.mocked(getFlowEnrollments)).not.toHaveBeenCalled();
    expect(jest.mocked(getFlowSteps)).not.toHaveBeenCalled();
    expect(jest.mocked(getDbPool)).not.toHaveBeenCalled();
  });

  it("get_email_flow_stats reads stats only for the owner's own flow", async () => {
    jest.mocked(getEmailFlow).mockResolvedValue({
      id: 7,
      seller_pubkey: ownerPubkey,
      name: "mine",
      flow_type: "welcome",
      status: "active",
    } as any);
    jest.mocked(getFlowEnrollments).mockResolvedValue([]);
    jest.mocked(getFlowSteps).mockResolvedValue([]);
    const release = jest.fn();
    jest.mocked(getDbPool).mockReturnValue({
      connect: jest.fn(async () => ({ query: jest.fn(), release })),
    } as any);
    const cb = writeTools().get("get_email_flow_stats")!;

    const result = await cb({ flow_id: 7 });

    expect(result.isError).toBeFalsy();
    expect(payload(result).flow.id).toBe(7);
  });

  it("get_cashu_balance ignores proof events from other sellers", async () => {
    const proofEvent = (pubkey: string, amount: number) => ({
      id: `${pubkey.slice(0, 8)}-event`,
      pubkey,
      kind: 7375,
      created_at: 1,
      content: JSON.stringify({
        mint: "https://mint.example",
        proofs: [{ amount }],
      }),
      tags: [],
      sig: "0".repeat(128),
    });
    jest
      .mocked(fetchCachedEvents)
      .mockResolvedValue([
        proofEvent(ownerPubkey, 100),
        proofEvent(otherPubkey, 999_999),
      ] as any);
    const cb = writeTools().get("get_cashu_balance")!;

    const result = await cb({});

    const body = payload(result);
    expect(result.isError).toBeFalsy();
    expect(body.totalBalance).toBe(100);
    expect(body.proofEventCount).toBe(1);
  });

  it("get_membership_status reports only the key owner's membership", async () => {
    jest.mocked(getMembershipView).mockResolvedValue({
      pubkey: ownerPubkey,
      status: "active",
      isPro: true,
    } as any);
    const cb = readTools({ apiKeyId: 1, pubkey: ownerPubkey }).get(
      "get_membership_status"
    )!;

    const result = await cb({});

    expect(jest.mocked(getMembershipView)).toHaveBeenCalledWith(ownerPubkey);
    expect(result.isError).toBeFalsy();
  });

  it("get_membership_status fails closed for keyless sessions", async () => {
    const cb = readTools(undefined).get("get_membership_status")!;

    const result = await cb({});

    expect(result.isError).toBe(true);
    expect(jest.mocked(getMembershipView)).not.toHaveBeenCalled();
  });
});

describe("purchase-tools owner scoping", () => {
  // A pool double that records every query text + params.
  function recordingPool(rowsByQuery: Array<[RegExp, any[]]>) {
    const calls: Array<{ text: string; params: any[] }> = [];
    const client = {
      query: jest.fn(async (text: string, params: any[] = []) => {
        calls.push({ text, params });
        const match = rowsByQuery.find(([pattern]) => pattern.test(text));
        return { rows: match ? match[1] : [] };
      }),
      release: jest.fn(),
    };
    jest.mocked(getDbPool).mockReturnValue({
      connect: jest.fn(async () => client),
    } as any);
    return calls;
  }

  const order = {
    id: 1,
    order_id: "order-1",
    api_key_id: 1,
    buyer_pubkey: "buyer".padEnd(64, "0"),
    seller_pubkey: "seller".padEnd(64, "0"),
    product_id: "p1",
    product_title: null,
    quantity: 1,
    amount_total: 10,
    currency: "USD",
    buyer_email: null,
    shipping_address: null,
    payment_intent_id: null,
    payment_status: "pending",
    order_status: "pending",
    created_at: "",
    updated_at: "",
  };

  beforeEach(() => jest.clearAllMocks());

  it("listMcpOrders filters by buyer pubkey in SQL", async () => {
    const calls = recordingPool([[/SELECT \* FROM mcp_orders/, []]]);

    await listMcpOrders("buyer-pubkey", 10, 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("WHERE buyer_pubkey = $1");
    expect(calls[0]!.params).toEqual(["buyer-pubkey", 10, 5]);
  });

  it("listMcpOrdersAsSeller filters by seller pubkey in SQL", async () => {
    const calls = recordingPool([[/SELECT \* FROM mcp_orders/, []]]);

    await listMcpOrdersAsSeller("seller-pubkey", 10, 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("WHERE seller_pubkey = $1");
    expect(calls[0]!.params).toEqual(["seller-pubkey", 10, 5]);
  });

  it("updateMcpOrderStatus refuses a non-participant without running UPDATE", async () => {
    const calls = recordingPool([[/SELECT \* FROM mcp_orders/, [order]]]);

    const result = await updateMcpOrderStatus(
      "order-1",
      "shipped",
      otherPubkey
    );

    expect(result).toBeNull();
    expect(calls.some((c) => /UPDATE mcp_orders/.test(c.text))).toBe(false);
  });

  it("updateMcpOrderStatus scopes the UPDATE to the actor's owner column", async () => {
    const calls = recordingPool([
      [/SELECT \* FROM mcp_orders/, [order]],
      [/UPDATE mcp_orders/, [{ ...order, order_status: "shipped" }]],
    ]);

    const result = await updateMcpOrderStatus(
      "order-1",
      "shipped",
      order.seller_pubkey
    );

    expect(result).not.toBeNull();
    const update = calls.find((c) => /UPDATE mcp_orders/.test(c.text))!;
    expect(update.text).toContain("AND seller_pubkey = $3");
    expect(update.params[2]).toBe(order.seller_pubkey);
  });

  it("updateMcpOrderAddress scopes the UPDATE to the buyer pubkey", async () => {
    const calls = recordingPool([
      [/UPDATE mcp_orders/, [{ ...order, shipping_address: {} }]],
    ]);

    await updateMcpOrderAddress("order-1", "buyer-pubkey", {
      address: "1 Main St",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("WHERE order_id = $2 AND buyer_pubkey = $3");
    expect(calls[0]!.params[2]).toBe("buyer-pubkey");
  });

  it("getMcpOrder callers stay gated: raw lookup is by id only", async () => {
    // getMcpOrder intentionally looks up by id alone; every caller
    // (create-order.ts handleGetOrder, verify-payment.ts, ucp checkout
    // sessions, write-tools update_order_status/send_shipping_update) checks
    // buyer/seller membership before returning or mutating. This test pins
    // that the helper itself performs no scoping so the caller checks remain
    // mandatory.
    const calls = recordingPool([[/SELECT \* FROM mcp_orders/, [order]]]);

    const found = await getMcpOrder("order-1");

    expect(found).toEqual(order);
    expect(calls[0]!.text).not.toContain("buyer_pubkey");
    expect(calls[0]!.text).not.toContain("seller_pubkey");
  });
});
