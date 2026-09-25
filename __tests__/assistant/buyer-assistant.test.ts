// Buyer/guest storefront assistant: route gating (stall toggle + owner Pro
// entitlement + anonymous MCP session) plus the pure helpers that define the
// buyer surface. The MCP bridge, agent loop, DB, and membership lookups are
// mocked at their module seams, so these tests need no database, network, or
// LLM access.

const applyRateLimitMock = jest.fn();
const verifyNip98RequestMock = jest.fn();
const fetchShopProfileMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();
const runBuyerAssistantMock = jest.fn();
const mcpConstructorMock = jest.fn();
const mcpConnectMock = jest.fn();
const mcpCloseMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
  getRequestIp: () => "127.0.0.1",
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // db-service mocks must provide getDbPool: other utils/db modules call it
  // at module scope and a bare mock breaks the whole suite at import time.
  getDbPool: jest.fn(),
  fetchShopProfileByPubkeyFromDb: (...args: unknown[]) =>
    fetchShopProfileMock(...args),
}));

jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: (...args: unknown[]) => isPubkeyProEntitledMock(...args),
}));

jest.mock("@/utils/assistant/mcp-client", () => {
  const actual = jest.requireActual("@/utils/assistant/mcp-client");
  return {
    ...actual,
    McpLoopbackClient: jest.fn().mockImplementation((...args: unknown[]) => {
      mcpConstructorMock(...args);
      return { connect: mcpConnectMock, close: mcpCloseMock };
    }),
  };
});

jest.mock("@/utils/assistant/agent", () => {
  const actual = jest.requireActual("@/utils/assistant/agent");
  return {
    ...actual,
    runBuyerAssistant: (...args: unknown[]) => runBuyerAssistantMock(...args),
  };
});

// The seller path is not under test here, but chat.ts imports it; keep the
// seller-side helpers inert.
jest.mock("@/utils/assistant/assistant-key", () => ({
  ensureAssistantTables: jest.fn(),
  getOrCreateAssistantKey: jest.fn(),
  getAssistantSigningState: jest.fn(),
  getAssistantRawKey: jest.fn(),
  invalidateAssistantRawKey: () => undefined,
  provisionAssistantSigning: jest.fn(),
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: jest.fn().mockResolvedValue(true),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import chatHandler from "@/pages/api/assistant/chat";
import {
  isBuyerToolAllowed,
  filterBuyerAssistantTools,
  isAssistantToolAllowed,
} from "@/utils/assistant/tools";
import {
  readAssistantVisibility,
  parseAssistantVisibilityFromContent,
} from "@/utils/assistant/stall-visibility";

const STALL_PUBKEY = "c".repeat(64);

function createMockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode: number; body: unknown };
}

function createBuyerReq(overrides: Partial<NextApiRequest> = {}) {
  return {
    method: "POST",
    headers: {}, // guest: no NIP-98 header at all
    body: {
      messages: [{ role: "user", content: "What do you sell?" }],
      context: { stallPubkey: STALL_PUBKEY },
    },
    ...overrides,
  } as unknown as NextApiRequest;
}

function shopEventWith(storefront: unknown) {
  return {
    content: JSON.stringify({ name: "Sunrise Farm", storefront }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  verifyNip98RequestMock.mockResolvedValue({ ok: false, error: "no auth" });
  fetchShopProfileMock.mockResolvedValue(
    shopEventWith({ assistantVisibility: { buyers: true } })
  );
  isPubkeyProEntitledMock.mockResolvedValue(true);
  mcpConnectMock.mockResolvedValue(undefined);
  mcpCloseMock.mockResolvedValue(undefined);
  runBuyerAssistantMock.mockResolvedValue({
    reply: "We sell raw honey and fresh eggs.",
    actions: [],
  });
});

describe("POST /api/assistant/chat — buyer/guest storefront mode", () => {
  it("403s when the stall has not opted in to the buyer assistant", async () => {
    fetchShopProfileMock.mockResolvedValue(shopEventWith({}));
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(403);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("403s when the stall has no shop profile event at all", async () => {
    fetchShopProfileMock.mockResolvedValue(null);
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(403);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("403s when the stall owner is not Pro-entitled", async () => {
    isPubkeyProEntitledMock.mockResolvedValue(false);
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(403);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("403s (fails closed) when the membership lookup throws", async () => {
    isPubkeyProEntitledMock.mockRejectedValue(new Error("db down"));
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(403);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("stops when the buyer rate limiter fires", async () => {
    applyRateLimitMock.mockImplementation(async (_req, res) => {
      res.status(429).json({ error: "slow down" });
      return false;
    });
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(429);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("400s on a malformed messages payload", async () => {
    const res = createMockRes();
    await chatHandler(createBuyerReq({ body: { context: { stallPubkey: STALL_PUBKEY } } }), res);
    expect(res.statusCode).toBe(400);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });

  it("runs the buyer assistant over an ANONYMOUS MCP session (no key)", async () => {
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      reply: "We sell raw honey and fresh eggs.",
      audience: "buyer",
    });
    // No raw key argument = anonymous session = public catalog tools only.
    expect(mcpConstructorMock).toHaveBeenCalledWith();
    expect(mcpConstructorMock).not.toHaveBeenCalledWith(
      expect.anything()
    );
    expect(runBuyerAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({ shopName: "Sunrise Farm" })
    );
    expect(mcpCloseMock).toHaveBeenCalled();
  });

  it("treats a signed-in NON-owner as a buyer (buyer tools only)", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: "d".repeat(64), // signed in, but not the stall owner
    });
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { audience?: string }).audience).toBe("buyer");
    expect(runBuyerAssistantMock).toHaveBeenCalled();
  });

  it("routes the stall owner's own signed request to the SELLER flow", async () => {
    verifyNip98RequestMock.mockResolvedValue({
      ok: true,
      pubkey: STALL_PUBKEY,
    });
    const res = createMockRes();
    await chatHandler(createBuyerReq(), res);
    // Seller flow: buyer assistant never runs. (Seller loop itself is mocked
    // in the sibling suite; here we only assert the routing decision.)
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
    expect(res.statusCode).not.toBe(403);
  });

  it("ignores a malformed stall context and requires NIP-98 (marketplace behavior unchanged)", async () => {
    const res = createMockRes();
    await chatHandler(
      createBuyerReq({
        body: {
          messages: [{ role: "user", content: "hi" }],
          context: { stallPubkey: "not-a-pubkey" },
        },
      }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(runBuyerAssistantMock).not.toHaveBeenCalled();
  });
});

describe("readAssistantVisibility", () => {
  it("defaults to buyers off / seller on", () => {
    expect(readAssistantVisibility(null)).toEqual({
      buyers: false,
      seller: true,
    });
    expect(readAssistantVisibility({})).toEqual({
      buyers: false,
      seller: true,
    });
    expect(readAssistantVisibility({ storefront: {} })).toEqual({
      buyers: false,
      seller: true,
    });
  });

  it("reads explicit toggle values", () => {
    expect(
      readAssistantVisibility({
        storefront: { assistantVisibility: { buyers: true, seller: false } },
      })
    ).toEqual({ buyers: true, seller: false });
  });

  it("ignores non-boolean garbage", () => {
    expect(
      readAssistantVisibility({
        storefront: { assistantVisibility: { buyers: "yes", seller: 0 } },
      })
    ).toEqual({ buyers: false, seller: true });
  });
});

describe("parseAssistantVisibilityFromContent", () => {
  it("parses toggles and shop name from event content JSON", () => {
    expect(
      parseAssistantVisibilityFromContent(
        JSON.stringify({
          name: "Sunrise Farm",
          storefront: { assistantVisibility: { buyers: true } },
        })
      )
    ).toEqual({ buyers: true, seller: true, shopName: "Sunrise Farm" });
  });

  it("fails closed on malformed JSON", () => {
    expect(parseAssistantVisibilityFromContent("{oops")).toEqual({
      buyers: false,
      seller: true,
      shopName: null,
    });
    expect(parseAssistantVisibilityFromContent(null)).toEqual({
      buyers: false,
      seller: true,
      shopName: null,
    });
  });
});

describe("buyer tool allowlist", () => {
  it("includes the public catalog reads", () => {
    for (const tool of [
      "search_products",
      "get_categories",
      "get_product_details",
      "get_storefront",
      "get_reviews",
      "check_discount_code",
      "list_companies",
      "get_company_details",
    ]) {
      expect(isBuyerToolAllowed(tool)).toBe(true);
    }
  });

  it("excludes every seller-ops read and every write", () => {
    for (const tool of [
      // seller account reads
      "list_seller_orders",
      "get_order_status",
      "get_notifications",
      "get_email_analytics",
      "get_stock",
      "get_cashu_balance",
      "get_membership_status",
      "get_stripe_connect_status",
      // writes
      "create_product_listing",
      "update_product_listing",
      "set_stock",
      "update_order_status",
      "create_discount_code",
      "send_broadcast_email",
      "purchase_shipping_label",
      // order placement is NOT part of the buyer assistant
      "create_order",
    ]) {
      expect(isBuyerToolAllowed(tool)).toBe(false);
    }
  });

  it("filters a mixed tool list down to the buyer surface", () => {
    const filtered = filterBuyerAssistantTools([
      { name: "search_products" },
      { name: "list_seller_orders" },
      { name: "get_reviews" },
      { name: "update_product_listing" },
      { name: "made_up_tool" },
    ]);
    expect(filtered.map((t) => t.name)).toEqual([
      "search_products",
      "get_reviews",
    ]);
  });

  it("stays a strict subset of the seller assistant's read surface", () => {
    // Every buyer tool must also be a tool the seller assistant can read —
    // the buyer surface can never exceed the seller read surface.
    const buyerTools = [
      "search_products",
      "get_categories",
      "get_product_details",
      "get_storefront",
      "get_reviews",
      "check_discount_code",
      "list_companies",
      "get_company_details",
    ];
    for (const tool of buyerTools) {
      expect(isAssistantToolAllowed(tool, false)).toBe(true);
    }
  });
});
