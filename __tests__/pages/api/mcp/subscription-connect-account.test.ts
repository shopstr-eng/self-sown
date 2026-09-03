/**
 * Behavioral test for the cancel_subscription / update_subscription MCP
 * tools (Task: canceling or updating a subscription must act on the seller's
 * own Stripe account).
 *
 * Covers:
 *  - when the seller has a Stripe Connect account, the request body sent to
 *    /api/stripe/cancel-subscription and /api/stripe/update-subscription
 *    carries connectedAccountId = that account's stripe_account_id.
 *  - when the seller has no Connect account, connectedAccountId is omitted.
 *  - a subscription the seller doesn't own is rejected without any fetch.
 *
 * Mocking pattern copied from get-email-popup.test.ts: db-service and
 * mcp/auth are stubbed with functional fakes so the real tool handlers run;
 * register-tool is captured so handlers can be invoked by name.
 */

const mockGetSubscriptionsBySellerPubkey = jest.fn();
const mockGetStripeConnectAccount = jest.fn();
const mockGetAgentSigner = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getSubscriptionsBySellerPubkey: (...args: any[]) =>
    mockGetSubscriptionsBySellerPubkey(...args),
  getStripeConnectAccount: (...args: any[]) =>
    mockGetStripeConnectAccount(...args),
}));
jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));
jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: (...args: any[]) => mockGetAgentSigner(...args),
}));
jest.mock("@/utils/mcp/nostr-signing", () => ({
  signAndPublishEvent: jest.fn(),
}));
jest.mock("@/utils/mcp/request-proof", () => ({}));
jest.mock("@/utils/nostr/request-auth", () => ({
  SIGNED_EVENT_HEADER: "x-signed-event",
  buildSignedHttpRequestProofTemplate: (proof: any) => ({
    kind: 27235,
    tags: [["proof", JSON.stringify(proof)]],
  }),
  buildCancelSubscriptionProof: (args: any) => ({
    action: "cancel_subscription",
    ...args,
  }),
  buildUpdateSubscriptionProof: (args: any) => ({
    action: "update_subscription",
    ...args,
  }),
}));
jest.mock("@/utils/lightning/direct-lnurl", () => ({
  derivePaymentPreference: jest.fn(),
}));
jest.mock("@/utils/email/flow-email-templates", () => ({
  getDefaultFlowSteps: jest.fn(),
}));
jest.mock("@/mcp/tools/order-status-auth", () => ({}));
jest.mock("@/mcp/audit-log", () => ({
  wrapWithAudit: (_name: string, cb: any) => cb,
}));
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {},
}));
jest.mock("@milk-market/nostr", () => ({
  createSellerActionAuthEventTemplate: jest.fn(),
}));

// Capture tool handlers by name via the real register-tool module's caller.
type ToolHandler = (params: any, extra?: any) => Promise<any>;
const toolHandlers: Record<string, ToolHandler> = {};
jest.mock("@/mcp/tools/register-tool", () => ({
  registerTool: (
    _server: any,
    name: string,
    _description: string,
    _inputSchema: any,
    cb: ToolHandler
  ) => {
    toolHandlers[name] = cb;
  },
}));

import { registerWriteTools } from "@/mcp/tools/write-tools";

const SELLER_PUBKEY = "a".repeat(64);
const SUB_ID = "sub_123";
const CONNECT_ACCOUNT_ID = "acct_seller_1";

const apiKey = {
  id: "key-1",
  pubkey: SELLER_PUBKEY,
  permissions: "full_access",
} as any;

function parseToolResult(result: any) {
  return JSON.parse(result.content[0].text);
}

function lastFetchBody() {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url: call[0] as string, body: JSON.parse(call[1].body) };
}

beforeAll(() => {
  registerWriteTools({} as any, apiKey);
  (global as any).fetch = (...args: any[]) => mockFetch(...args);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAgentSigner.mockResolvedValue({
    signer: {
      getPubKey: () => SELLER_PUBKEY,
      sign: (template: any) => ({ ...template, id: "evt", sig: "sig" }),
    },
  });
  mockGetSubscriptionsBySellerPubkey.mockResolvedValue([
    { stripe_subscription_id: SUB_ID, seller_pubkey: SELLER_PUBKEY },
  ]);
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: SUB_ID, status: "canceled" }),
  });
});

describe("cancel_subscription", () => {
  test("prefers the account id stored on the subscription over the current connect account", async () => {
    mockGetSubscriptionsBySellerPubkey.mockResolvedValue([
      {
        stripe_subscription_id: SUB_ID,
        seller_pubkey: SELLER_PUBKEY,
        connected_account_id: "acct_original",
      },
    ]);
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: "acct_reconnected_different",
    });

    const result = parseToolResult(
      await toolHandlers["cancel_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockGetStripeConnectAccount).not.toHaveBeenCalled();
    const { body } = lastFetchBody();
    expect(body.connectedAccountId).toBe("acct_original");
  });

  test("falls back to the current connect account for legacy rows without a stored account", async () => {
    mockGetSubscriptionsBySellerPubkey.mockResolvedValue([
      {
        stripe_subscription_id: SUB_ID,
        seller_pubkey: SELLER_PUBKEY,
        connected_account_id: null,
      },
    ]);
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT_ID,
    });

    const result = parseToolResult(
      await toolHandlers["cancel_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockGetStripeConnectAccount).toHaveBeenCalledWith(SELLER_PUBKEY);
    const { body } = lastFetchBody();
    expect(body.connectedAccountId).toBe(CONNECT_ACCOUNT_ID);
  });

  test("passes the seller's connected account id when one exists", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT_ID,
    });

    const result = parseToolResult(
      await toolHandlers["cancel_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockGetStripeConnectAccount).toHaveBeenCalledWith(SELLER_PUBKEY);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, body } = lastFetchBody();
    expect(url).toContain("/api/stripe/cancel-subscription");
    expect(body.subscriptionId).toBe(SUB_ID);
    expect(body.connectedAccountId).toBe(CONNECT_ACCOUNT_ID);
  });

  test("omits connectedAccountId when the seller has no connect account", async () => {
    mockGetStripeConnectAccount.mockResolvedValue(null);

    const result = parseToolResult(
      await toolHandlers["cancel_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { body } = lastFetchBody();
    expect(body.subscriptionId).toBe(SUB_ID);
    expect("connectedAccountId" in body).toBe(false);
  });

  test("rejects a subscription the seller doesn't own without calling Stripe", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT_ID,
    });

    const result = await toolHandlers["cancel_subscription"]!({
      subscriptionId: "sub_not_mine",
    });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toBe("Subscription not found");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("update_subscription", () => {
  test("prefers the account id stored on the subscription over the current connect account", async () => {
    mockGetSubscriptionsBySellerPubkey.mockResolvedValue([
      {
        stripe_subscription_id: SUB_ID,
        seller_pubkey: SELLER_PUBKEY,
        connected_account_id: "acct_original",
      },
    ]);
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: "acct_reconnected_different",
    });

    const result = parseToolResult(
      await toolHandlers["update_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockGetStripeConnectAccount).not.toHaveBeenCalled();
    const { body } = lastFetchBody();
    expect(body.connectedAccountId).toBe("acct_original");
  });

  test("passes the seller's connected account id when one exists", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT_ID,
    });

    const shippingAddress = { line1: "1 Farm Rd", country: "US" };
    const result = parseToolResult(
      await toolHandlers["update_subscription"]!({
        subscriptionId: SUB_ID,
        shippingAddress,
        nextBillingDate: "2026-10-01T00:00:00Z",
      })
    );
    expect(result.success).toBe(true);

    expect(mockGetStripeConnectAccount).toHaveBeenCalledWith(SELLER_PUBKEY);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, body } = lastFetchBody();
    expect(url).toContain("/api/stripe/update-subscription");
    expect(body.subscriptionId).toBe(SUB_ID);
    expect(body.connectedAccountId).toBe(CONNECT_ACCOUNT_ID);
    expect(body.shippingAddress).toEqual(shippingAddress);
    expect(body.nextBillingDate).toBe("2026-10-01T00:00:00Z");
  });

  test("omits connectedAccountId when the seller has no connect account", async () => {
    mockGetStripeConnectAccount.mockResolvedValue(undefined);

    const result = parseToolResult(
      await toolHandlers["update_subscription"]!({ subscriptionId: SUB_ID })
    );
    expect(result.success).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { body } = lastFetchBody();
    expect(body.subscriptionId).toBe(SUB_ID);
    expect("connectedAccountId" in body).toBe(false);
  });

  test("rejects a subscription the seller doesn't own without calling Stripe", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT_ID,
    });

    const result = await toolHandlers["update_subscription"]!({
      subscriptionId: "sub_not_mine",
    });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toBe("Subscription not found");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
