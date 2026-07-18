/**
 * Behavioral test for the get_email_popup MCP tool and the
 * get -> set_email_popup round-trip (Task: confirm agents can read then
 * safely update the popup without losing styling).
 *
 * Covers:
 *  - get_email_popup returns the FULL emailPopup (style, flowSteps,
 *    shippingDiscountType/Value) from the LATEST kind-30019 event.
 *  - get_email_popup returns configured:false / emailPopup:null when unset.
 *  - a get -> set_email_popup round-trip (agent changes only the headline)
 *    preserves every omitted field, including style and flowSteps.
 *
 * Heavy transitive imports of write-tools are stubbed like in the sibling
 * email-popup-schema-parity test; db-service and nostr-signing are stubbed
 * with functional fakes so the handlers actually run.
 */

const mockFetchAllProfilesFromDb = jest.fn();
const mockCacheEvent = jest.fn().mockResolvedValue(undefined);
const mockSignAndPublishEvent = jest.fn();
const mockGetAgentSigner = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  fetchAllProfilesFromDb: (...args: any[]) =>
    mockFetchAllProfilesFromDb(...args),
  cacheEvent: (...args: any[]) => mockCacheEvent(...args),
}));
jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));
jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: (...args: any[]) => mockGetAgentSigner(...args),
}));
jest.mock("@/utils/mcp/nostr-signing", () => ({
  signAndPublishEvent: (...args: any[]) => mockSignAndPublishEvent(...args),
}));
jest.mock("@/utils/mcp/request-proof", () => ({}));
jest.mock("@/utils/nostr/request-auth", () => ({}));
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
const toolSchemas: Record<string, any> = {};
jest.mock("@/mcp/tools/register-tool", () => ({
  registerTool: (
    _server: any,
    name: string,
    _description: string,
    inputSchema: any,
    cb: ToolHandler
  ) => {
    toolHandlers[name] = cb;
    toolSchemas[name] = inputSchema;
  },
}));

import { z } from "zod";
import { registerWriteTools } from "@/mcp/tools/write-tools";

const SELLER_PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);

const FULL_POPUP = {
  enabled: true,
  displayMode: "fullscreen",
  discountPercentage: 10,
  shippingDiscountType: "percent",
  shippingDiscountValue: 50,
  headline: "Get 10% Off",
  subtext: "Join the herd",
  collectPhone: true,
  requirePhone: false,
  buttonText: "Get My Discount",
  successMessage: "Check your inbox!",
  style: {
    backgroundColor: "#ffffff",
    textColor: "#111111",
    accentColor: "#4a7c59",
    buttonColor: "#222222",
    buttonTextColor: "#ffffff",
    backgroundImage: "https://example.com/bg.jpg",
    overlayOpacity: 0.4,
    useCustomFonts: true,
  },
  flowSteps: [
    {
      id: "step-1",
      question: "What brings you here?",
      answers: [
        { id: "a-1", label: "Raw milk", nextStepId: "step-2" },
        { id: "a-2", label: "Just browsing" },
      ],
    },
    {
      id: "step-2",
      question: "How often do you buy?",
      answers: [{ id: "a-3", label: "Weekly" }],
    },
  ],
};

function profileEvent(
  pubkey: string,
  createdAt: number,
  storefront: Record<string, any> | null
) {
  return {
    id: `evt-${pubkey.slice(0, 4)}-${createdAt}`,
    kind: 30019,
    pubkey,
    created_at: createdAt,
    content: JSON.stringify(storefront ? { storefront } : { name: "Shop" }),
    tags: [["d", pubkey]],
  };
}

function parseToolResult(result: any) {
  return JSON.parse(result.content[0].text);
}

const apiKey = {
  id: "key-1",
  pubkey: SELLER_PUBKEY,
  permissions: "full_access",
} as any;

beforeAll(() => {
  registerWriteTools({} as any, apiKey);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCacheEvent.mockResolvedValue(undefined);
  mockGetAgentSigner.mockResolvedValue({
    signer: { getPubKey: () => SELLER_PUBKEY },
  });
  mockSignAndPublishEvent.mockImplementation(
    async (_signer: any, template: any) => ({
      ...template,
      id: "signed-event-id",
      pubkey: SELLER_PUBKEY,
      sig: "sig",
    })
  );
});

describe("get_email_popup", () => {
  test("returns the full emailPopup from the LATEST kind-30019 event", async () => {
    const stalePopup = { enabled: false, headline: "Old" };
    mockFetchAllProfilesFromDb.mockResolvedValue([
      profileEvent(SELLER_PUBKEY, 1000, { emailPopup: stalePopup }),
      profileEvent(SELLER_PUBKEY, 2000, { emailPopup: FULL_POPUP }),
      profileEvent(OTHER_PUBKEY, 3000, {
        emailPopup: { enabled: true, headline: "Someone else's popup" },
      }),
    ]);

    const result = parseToolResult(await toolHandlers["get_email_popup"]({}));

    expect(result.success).toBe(true);
    expect(result.pubkey).toBe(SELLER_PUBKEY);
    expect(result.configured).toBe(true);
    // Full config, including style, flowSteps and shipping discount fields
    expect(result.emailPopup).toEqual(FULL_POPUP);
    expect(result.emailPopup.style).toEqual(FULL_POPUP.style);
    expect(result.emailPopup.flowSteps).toEqual(FULL_POPUP.flowSteps);
    expect(result.emailPopup.shippingDiscountType).toBe("percent");
    expect(result.emailPopup.shippingDiscountValue).toBe(50);
  });

  test("returns configured:false and emailPopup:null when the popup is unset", async () => {
    mockFetchAllProfilesFromDb.mockResolvedValue([
      profileEvent(SELLER_PUBKEY, 1000, { primaryColor: "#fff" }),
    ]);

    const result = parseToolResult(await toolHandlers["get_email_popup"]({}));

    expect(result.success).toBe(true);
    expect(result.configured).toBe(false);
    expect(result.emailPopup).toBeNull();
  });

  test("returns configured:false when the seller has no profile event at all", async () => {
    mockFetchAllProfilesFromDb.mockResolvedValue([
      profileEvent(OTHER_PUBKEY, 1000, { emailPopup: FULL_POPUP }),
    ]);

    const result = parseToolResult(await toolHandlers["get_email_popup"]({}));

    expect(result.configured).toBe(false);
    expect(result.emailPopup).toBeNull();
  });

  test("errors when no signer is configured", async () => {
    mockGetAgentSigner.mockResolvedValue(null);
    const result = await toolHandlers["get_email_popup"]({});
    expect(result.isError).toBe(true);
  });
});

describe("get -> set_email_popup round-trip", () => {
  test("updating only the headline preserves style, flowSteps and shipping discount", async () => {
    mockFetchAllProfilesFromDb.mockResolvedValue([
      profileEvent(SELLER_PUBKEY, 2000, {
        primaryColor: "#123456",
        emailPopup: FULL_POPUP,
      }),
    ]);

    // Step 1: agent reads the current config.
    const current = parseToolResult(
      await toolHandlers["get_email_popup"]({})
    ).emailPopup;
    expect(current).toEqual(FULL_POPUP);

    // Step 2: agent sends a minimal update through the real tool boundary
    // (zod strips unknown keys and validates), changing only the headline.
    const setSchema = z.object(toolSchemas["set_email_popup"]);
    const params = setSchema.parse({
      enabled: current.enabled,
      discountPercentage: current.discountPercentage,
      headline: "New Headline",
    });

    const setResult = parseToolResult(
      await toolHandlers["set_email_popup"](params)
    );
    expect(setResult.success).toBe(true);

    // Both the tool response and the published event must keep every
    // omitted field intact.
    const expected = { ...FULL_POPUP, headline: "New Headline" };
    expect(setResult.emailPopup).toEqual(expected);

    expect(mockSignAndPublishEvent).toHaveBeenCalledTimes(1);
    const publishedTemplate = mockSignAndPublishEvent.mock.calls[0][1];
    expect(publishedTemplate.kind).toBe(30019);
    expect(publishedTemplate.tags).toEqual([["d", SELLER_PUBKEY]]);
    const publishedContent = JSON.parse(publishedTemplate.content);
    expect(publishedContent.storefront.emailPopup).toEqual(expected);
    // Other storefront fields on the event are untouched too.
    expect(publishedContent.storefront.primaryColor).toBe("#123456");
    expect(mockCacheEvent).toHaveBeenCalledTimes(1);
  });

  test("set_email_popup with explicit style/flowSteps replaces them", async () => {
    mockFetchAllProfilesFromDb.mockResolvedValue([
      profileEvent(SELLER_PUBKEY, 2000, { emailPopup: FULL_POPUP }),
    ]);

    const setSchema = z.object(toolSchemas["set_email_popup"]);
    const newStyle = { backgroundColor: "#000000", textColor: "#ffffff" };
    const params = setSchema.parse({
      enabled: true,
      discountPercentage: 15,
      style: newStyle,
      flowSteps: [],
    });

    const result = parseToolResult(
      await toolHandlers["set_email_popup"](params)
    );
    expect(result.emailPopup.style).toEqual(newStyle);
    expect(result.emailPopup.flowSteps).toEqual([]);
    expect(result.emailPopup.discountPercentage).toBe(15);
    // Non-style omitted fields still preserved.
    expect(result.emailPopup.headline).toBe(FULL_POPUP.headline);
    expect(result.emailPopup.shippingDiscountValue).toBe(50);
  });
});
