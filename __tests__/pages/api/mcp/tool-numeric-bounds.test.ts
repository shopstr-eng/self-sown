/** @jest-environment node */

/**
 * Numeric input bounds pin for the read/write MCP tool modules
 * (mcp/tools/read-tools.ts and mcp/tools/write-tools.ts).
 *
 * Sibling order tools in pages/api/mcp/index.ts already bound their numeric
 * inputs (see pagination-bounds.test.ts), but these modules declared
 * agent-fed numbers as bare z.number(): a connected agent could pass
 * limit=1000000000 (one call scans/serializes whole tables) or absurd
 * amounts/ratings that flow straight into DB writes and Nostr events. The
 * schemas must reject out-of-range/fractional values BEFORE the tool callback
 * runs — this drives the tools through the real MCP SDK (registerReadTools /
 * registerWriteTools on a live McpServer + InMemoryTransport) so the
 * validation actually executes.
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
}));

jest.mock("@/utils/mcp/auth", () => ({
  extractBearerToken: jest.fn(),
  validateApiKey: jest.fn(),
  initializeApiKeysTable: jest.fn(),
  isApiKeyOwnerProEntitled: jest.fn(async () => true),
  MCP_PRO_REQUIRED_MESSAGE: "Pro required",
  getAgentSigner: jest.fn(async () => null),
}));

jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  setStock: jest.fn(),
}));

import { registerReadTools } from "@/mcp/tools/read-tools";
import { registerWriteTools } from "@/mcp/tools/write-tools";

const PUBKEY = "a".repeat(64);
const API_KEY = { id: 1, pubkey: PUBKEY, permissions: "full_access" } as any;

async function makeClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerReadTools(server);
  registerWriteTools(server, API_KEY);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

/** Asserts the SDK rejected the call at schema validation (error -32602). */
async function expectRejected(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  const result: any = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/-32602|Invalid/i);
}

/**
 * Asserts the call FAILED for the expected domain reason (cross-field rule in
 * the tool callback) — NOT at SDK schema validation and NOT later on.
 */
async function expectDomainRejected(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  pattern: RegExp
) {
  const result: any = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toMatch(/-32602/);
  expect(result.content[0].text).toMatch(pattern);
}

/**
 * Asserts the args passed schema validation AND any cross-field callback
 * checks: execution reaches the signer lookup, which fails with the mocked
 * "no signer" error (getAgentSigner returns null).
 */
async function expectPassedValidation(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  const result: any = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/No signing key configured/);
}

describe("MCP read/write tool numeric input bounds", () => {
  let client: Client;

  beforeAll(async () => {
    client = await makeClient();
  });

  afterAll(async () => {
    await client.close();
  });

  describe("read tools", () => {
    it.each([
      ["negative minPrice", { minPrice: -1 }],
      ["absurd minPrice", { minPrice: 1e16 }],
      ["negative maxPrice", { maxPrice: -5 }],
      ["absurd maxPrice", { maxPrice: 10000000000000000 }],
      ["limit of zero", { limit: 0 }],
      ["limit above the 50 cap", { limit: 51 }],
      ["fractional limit", { limit: 2.5 }],
    ])("search_products rejects %s", async (_label, args) => {
      await expectRejected(client, "search_products", args);
    });

    it.each([
      ["limit of zero", { limit: 0 }],
      ["limit above the 500 cap", { limit: 501 }],
      ["fractional limit", { limit: 1.5 }],
    ])("get_categories rejects %s", async (_label, args) => {
      await expectRejected(client, "get_categories", args);
    });

    it.each([
      ["limit of zero", { limit: 0 }],
      ["negative limit", { limit: -10 }],
      ["fractional limit", { limit: 3.5 }],
      ["absurd limit", { limit: 1000000000 }],
      ["limit above the 1000 cap", { limit: 1001 }],
    ])("list_companies rejects %s", async (_label, args) => {
      await expectRejected(client, "list_companies", args);
    });

    it("list_companies accepts in-range boundary values", async () => {
      const result: any = await client.callTool({
        name: "list_companies",
        arguments: { limit: 1000 },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("storefront section tools (set_shop_profile / set_email_popup / product listings)", () => {
    it.each([
      [
        "overlayOpacity below 0",
        {
          storefrontSections: [
            { id: "s1", type: "hero", overlayOpacity: -0.5 },
          ],
        },
      ],
      [
        "overlayOpacity above 1",
        { storefrontSections: [{ id: "s1", type: "hero", overlayOpacity: 2 }] },
      ],
      [
        "productLimit of zero",
        {
          storefrontSections: [{ id: "s1", type: "products", productLimit: 0 }],
        },
      ],
      [
        "productLimit above the 100 cap",
        {
          storefrontSections: [
            { id: "s1", type: "products", productLimit: 101 },
          ],
        },
      ],
      [
        "fractional productLimit",
        {
          storefrontSections: [
            { id: "s1", type: "products", productLimit: 2.5 },
          ],
        },
      ],
      [
        "testimonial rating of zero",
        {
          storefrontSections: [
            {
              id: "s1",
              type: "testimonials",
              testimonials: [{ quote: "q", author: "a", rating: 0 }],
            },
          ],
        },
      ],
      [
        "testimonial rating above 5",
        {
          storefrontSections: [
            {
              id: "s1",
              type: "testimonials",
              testimonials: [{ quote: "q", author: "a", rating: 6 }],
            },
          ],
        },
      ],
      [
        "bannerInterval too fast",
        {
          storefrontSections: [
            { id: "s1", type: "banner_carousel", bannerInterval: 100 },
          ],
        },
      ],
      [
        "absurd bannerInterval",
        {
          storefrontSections: [
            { id: "s1", type: "banner_carousel", bannerInterval: 1000000000 },
          ],
        },
      ],
      [
        "fractional bannerInterval",
        {
          storefrontSections: [
            { id: "s1", type: "banner_carousel", bannerInterval: 1500.5 },
          ],
        },
      ],
      [
        "socialPostsSpeed of zero",
        {
          storefrontSections: [
            { id: "s1", type: "social_posts", socialPostsSpeed: 0 },
          ],
        },
      ],
      [
        "fractional socialPostsSpeed",
        {
          storefrontSections: [
            { id: "s1", type: "social_posts", socialPostsSpeed: 40.5 },
          ],
        },
      ],
      [
        "socialPostsSpeed above the 600s cap",
        {
          storefrontSections: [
            { id: "s1", type: "social_posts", socialPostsSpeed: 601 },
          ],
        },
      ],
      [
        "marqueeSpeed of zero",
        {
          storefrontSections: [{ id: "s1", type: "marquee", marqueeSpeed: 0 }],
        },
      ],
      [
        "absurd marqueeSpeed",
        {
          storefrontSections: [
            { id: "s1", type: "marquee", marqueeSpeed: 1000000 },
          ],
        },
      ],
      [
        "blogPostLimit of zero",
        { storefrontSections: [{ id: "s1", type: "blog", blogPostLimit: 0 }] },
      ],
      [
        "blogPostLimit above the 100 cap",
        {
          storefrontSections: [{ id: "s1", type: "blog", blogPostLimit: 1000 }],
        },
      ],
      ["negative freeShippingThreshold", { freeShippingThreshold: -5 }],
      ["absurd freeShippingThreshold", { freeShippingThreshold: 1e15 }],
      [
        "paymentMethodDiscounts above 100%",
        { paymentMethodDiscounts: { bitcoin: 150 } },
      ],
      [
        "negative paymentMethodDiscounts",
        { paymentMethodDiscounts: { stripe: -10 } },
      ],
    ])("set_shop_profile rejects %s", async (_label, args) => {
      await expectRejected(client, "set_shop_profile", args);
    });

    it.each([
      [
        "absurd shippingDiscountValue",
        {
          enabled: true,
          discountPercentage: 10,
          shippingDiscountValue: 1000001,
        },
      ],
      [
        "negative shippingDiscountValue",
        { enabled: true, discountPercentage: 10, shippingDiscountValue: -1 },
      ],
    ])("set_email_popup rejects %s", async (_label, args) => {
      await expectRejected(client, "set_email_popup", args);
    });

    it.each([
      [
        "pageConfig overlayOpacity above 1",
        {
          pageConfig: {
            sections: [{ id: "s1", type: "hero", overlayOpacity: 1.5 }],
          },
        },
      ],
      [
        "pageConfig productLimit above the cap",
        {
          pageConfig: {
            sections: [{ id: "s1", type: "products", productLimit: 500 }],
          },
        },
      ],
    ])("update_product_listing rejects %s", async (_label, args) => {
      await expectRejected(client, "update_product_listing", {
        dTag: "prod-1",
        ...(args as object),
      });
    });
  });

  describe("messaging and review tools", () => {
    it.each([
      [
        "rating below 0",
        { content: "x", ratings: [{ category: "quality", value: -1 }] },
      ],
      [
        "rating above 5",
        { content: "x", ratings: [{ category: "quality", value: 6 }] },
      ],
    ])("publish_review rejects %s", async (_label, args) => {
      await expectRejected(client, "publish_review", args);
    });

    it.each([
      [
        "negative parentKind",
        {
          content: "x",
          communityId: "c",
          communityPubkey: PUBKEY,
          parentKind: -1,
        },
      ],
      [
        "fractional parentKind",
        {
          content: "x",
          communityId: "c",
          communityPubkey: PUBKEY,
          parentKind: 1.5,
        },
      ],
      [
        "parentKind above the 65535 cap",
        {
          content: "x",
          communityId: "c",
          communityPubkey: PUBKEY,
          parentKind: 65536,
        },
      ],
    ])("create_community_post rejects %s", async (_label, args) => {
      await expectRejected(client, "create_community_post", args);
    });

    it.each([
      [
        "negative orderAmount",
        { recipientPubkey: PUBKEY, message: "x", orderAmount: -100 },
      ],
      [
        "absurd orderAmount",
        { recipientPubkey: PUBKEY, message: "x", orderAmount: 1e16 },
      ],
    ])("send_direct_message rejects %s", async (_label, args) => {
      await expectRejected(client, "send_direct_message", args);
    });

    it.each([
      ["negative deliveryDays", { deliveryDays: -1 }],
      ["fractional deliveryDays", { deliveryDays: 2.5 }],
      ["absurd deliveryDays", { deliveryDays: 100000 }],
    ])("send_shipping_update rejects %s", async (_label, args) => {
      await expectRejected(client, "send_shipping_update", {
        orderId: "o1",
        buyerPubkey: PUBKEY,
        trackingNumber: "1Z",
        shippingCarrier: "USPS",
        ...(args as object),
      });
    });

    it.each([
      ["limit of zero", { limit: 0 }],
      ["limit above the 100 cap", { limit: 101 }],
      ["fractional limit", { limit: 1.5 }],
    ])("list_messages rejects %s", async (_label, args) => {
      await expectRejected(client, "list_messages", args);
    });
  });

  describe("discount code tools", () => {
    it.each([
      ["negative discountPercentage", { code: "X", discountPercentage: -1 }],
      ["discountPercentage above 100", { code: "X", discountPercentage: 101 }],
      [
        "negative expiration",
        { code: "X", discountPercentage: 10, expiration: -5 },
      ],
      [
        "fractional expiration",
        { code: "X", discountPercentage: 10, expiration: 1.5 },
      ],
      [
        "absurd expiration",
        { code: "X", discountPercentage: 10, expiration: 1e15 },
      ],
    ])("create_discount_code rejects %s", async (_label, args) => {
      await expectRejected(client, "create_discount_code", args);
    });
  });

  describe("email flow tools", () => {
    const step = {
      step_order: 1,
      subject: "s",
      body_html: "b",
      delay_hours: 1,
    };

    it.each([
      [
        "step_order of zero",
        {
          name: "f",
          flow_type: "welcome_series",
          steps: [{ ...step, step_order: 0 }],
        },
      ],
      [
        "fractional step_order",
        {
          name: "f",
          flow_type: "welcome_series",
          steps: [{ ...step, step_order: 1.5 }],
        },
      ],
      [
        "absurd step_order",
        {
          name: "f",
          flow_type: "welcome_series",
          steps: [{ ...step, step_order: 100000 }],
        },
      ],
      [
        "negative delay_hours",
        {
          name: "f",
          flow_type: "welcome_series",
          steps: [{ ...step, delay_hours: -1 }],
        },
      ],
      [
        "absurd delay_hours",
        {
          name: "f",
          flow_type: "welcome_series",
          steps: [{ ...step, delay_hours: 1000000 }],
        },
      ],
    ])("create_email_flow rejects %s", async (_label, args) => {
      await expectRejected(client, "create_email_flow", args);
    });

    it.each([
      ["flow_id of zero", { flow_id: 0 }],
      ["fractional flow_id", { flow_id: 1.5 }],
      ["absurd flow_id", { flow_id: 3000000000 }],
      ["step id of zero", { flow_id: 1, steps: [{ ...step, id: 0 }] }],
      [
        "negative step delay_hours",
        { flow_id: 1, steps: [{ ...step, delay_hours: -5 }] },
      ],
    ])("update_email_flow rejects %s", async (_label, args) => {
      await expectRejected(client, "update_email_flow", args);
    });

    it.each([
      ["flow_id of zero", { flow_id: 0 }],
      ["negative flow_id", { flow_id: -3 }],
      ["fractional flow_id", { flow_id: 2.5 }],
    ])("delete_email_flow rejects %s", async (_label, args) => {
      await expectRejected(client, "delete_email_flow", args);
    });

    it.each([
      ["flow_id of zero", { flow_id: 0 }],
      ["absurd flow_id", { flow_id: 1e10 }],
    ])("toggle_email_flow rejects %s", async (_label, args) => {
      await expectRejected(client, "toggle_email_flow", args);
    });

    it.each([
      ["flow_id of zero", { flow_id: 0 }],
      ["fractional flow_id", { flow_id: 9.9 }],
    ])("get_email_flow_stats rejects %s", async (_label, args) => {
      await expectRejected(client, "get_email_flow_stats", args);
    });

    it.each([
      ["limit of zero", { limit: 0 }],
      ["limit above the 500 cap", { limit: 501 }],
      ["fractional limit", { limit: 2.5 }],
      ["negative offset", { offset: -1 }],
      ["fractional offset", { offset: 0.5 }],
      ["absurd offset", { offset: 1000000000 }],
    ])("list_email_captures rejects %s", async (_label, args) => {
      await expectRejected(client, "list_email_captures", args);
    });
  });

  describe("affiliate tools", () => {
    it.each([
      ["update_affiliate", "update_affiliate", { affiliateId: 0 }],
      ["delete_affiliate", "delete_affiliate", { affiliateId: -1 }],
      [
        "regenerate_affiliate_invite_token",
        "regenerate_affiliate_invite_token",
        { affiliateId: 1.5 },
      ],
      [
        "set_affiliate_payouts_enabled",
        "set_affiliate_payouts_enabled",
        { affiliateId: 1e10, enabled: true },
      ],
      [
        "create_affiliate_code",
        "create_affiliate_code",
        { affiliateId: 0, code: "X", rebateType: "percent", rebateValue: 10 },
      ],
      [
        "mark_affiliate_paid",
        "mark_affiliate_paid",
        { affiliateId: -2, amountSmallest: 100, currency: "USD" },
      ],
    ])("%s rejects an invalid affiliateId", async (_label, tool, args) => {
      await expectRejected(
        client,
        tool as string,
        args as Record<string, unknown>
      );
    });

    it.each([
      [
        "negative rebateValue",
        { affiliateId: 1, code: "X", rebateType: "percent", rebateValue: -1 },
      ],
      [
        "absurd rebateValue",
        { affiliateId: 1, code: "X", rebateType: "fixed", rebateValue: 1e13 },
      ],
      [
        "negative buyerDiscountValue",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 10,
          buyerDiscountValue: -5,
        },
      ],
      [
        "negative expiration",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 10,
          expiration: -1,
        },
      ],
      [
        "maxUses of zero",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 10,
          maxUses: 0,
        },
      ],
      [
        "fractional maxUses",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 10,
          maxUses: 2.5,
        },
      ],
    ])("create_affiliate_code rejects %s", async (_label, args) => {
      await expectRejected(client, "create_affiliate_code", args);
    });

    it.each([
      ["codeId of zero", { codeId: 0 }],
      ["absurd codeId", { codeId: 3000000000 }],
      ["maxUses of zero", { codeId: 1, maxUses: 0 }],
      ["negative rebateValue", { codeId: 1, rebateValue: -1 }],
      ["absurd buyerDiscountValue", { codeId: 1, buyerDiscountValue: 1e13 }],
    ])("update_affiliate_code rejects %s", async (_label, args) => {
      await expectRejected(client, "update_affiliate_code", args);
    });

    it.each([
      ["codeId of zero", { codeId: 0 }],
      ["fractional codeId", { codeId: 3.3 }],
    ])("delete_affiliate_code rejects %s", async (_label, args) => {
      await expectRejected(client, "delete_affiliate_code", args);
    });

    it.each([
      [
        "amountSmallest of zero",
        { affiliateId: 1, amountSmallest: 0, currency: "USD" },
      ],
      [
        "fractional amountSmallest",
        { affiliateId: 1, amountSmallest: 10.5, currency: "USD" },
      ],
      [
        "absurd amountSmallest",
        { affiliateId: 1, amountSmallest: 1e16, currency: "USD" },
      ],
    ])("mark_affiliate_paid rejects %s", async (_label, args) => {
      await expectRejected(client, "mark_affiliate_paid", args);
    });

    it.each([
      [
        "negative originalGrossSmallest",
        { orderId: "o1", originalGrossSmallest: -1 },
      ],
      ["fractional refundedSmallest", { orderId: "o1", refundedSmallest: 1.5 }],
      ["absurd refundedSmallest", { orderId: "o1", refundedSmallest: 1e16 }],
    ])("reverse_affiliate_referral rejects %s", async (_label, args) => {
      await expectRejected(client, "reverse_affiliate_referral", args);
    });
  });

  describe("set_stock", () => {
    it.each([
      ["negative quantity", { productId: "p1", quantity: -1 }],
      ["fractional quantity", { productId: "p1", quantity: 1.5 }],
      ["absurd quantity", { productId: "p1", quantity: 10000000000 }],
    ])("set_stock rejects %s", async (_label, args) => {
      await expectRejected(client, "set_stock", args);
    });
  });

  describe("domain boundaries and discriminator-dependent limits", () => {
    it("accepts socialPostsSpeed in seconds (runtime default is 40s per loop)", async () => {
      await expectPassedValidation(client, "set_shop_profile", {
        storefrontSections: [
          { id: "s1", type: "social_posts", socialPostsSpeed: 40 },
        ],
      });
      await expectPassedValidation(client, "set_shop_profile", {
        storefrontSections: [
          { id: "s1", type: "social_posts", socialPostsSpeed: 120 },
        ],
      });
    });

    it("accepts bannerInterval in milliseconds at the boundaries", async () => {
      await expectPassedValidation(client, "set_shop_profile", {
        storefrontSections: [
          { id: "s1", type: "banner_carousel", bannerInterval: 5000 },
        ],
      });
    });

    it.each([
      [
        "percent rebateValue above 100",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 101,
        },
      ],
      [
        "percent buyerDiscountValue above 100 (default type is percent)",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "fixed",
          rebateValue: 500,
          buyerDiscountValue: 150,
        },
      ],
    ])("create_affiliate_code rejects %s", async (_label, args) => {
      await expectDomainRejected(
        client,
        "create_affiliate_code",
        args,
        /between 0 and 100/
      );
    });

    it.each([
      [
        "percent rebateValue at the 100 boundary",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "percent",
          rebateValue: 100,
        },
      ],
      [
        "fixed rebateValue at the NUMERIC(12,2) boundary",
        {
          affiliateId: 1,
          code: "X",
          rebateType: "fixed",
          rebateValue: 9999999999.99,
          currency: "USD",
        },
      ],
    ])("create_affiliate_code accepts %s", async (_label, args) => {
      await expectPassedValidation(client, "create_affiliate_code", args);
    });

    it("create_affiliate_code rejects a fixed rebateValue above the NUMERIC(12,2) column", async () => {
      await expectRejected(client, "create_affiliate_code", {
        affiliateId: 1,
        code: "X",
        rebateType: "fixed",
        rebateValue: 10000000000,
        currency: "USD",
      });
    });

    it.each([
      [
        "percent rebateValue above 100",
        { codeId: 1, rebateType: "percent", rebateValue: 150 },
      ],
      [
        "percent buyerDiscountValue above 100",
        { codeId: 1, buyerDiscountType: "percent", buyerDiscountValue: 100.5 },
      ],
    ])("update_affiliate_code rejects %s", async (_label, args) => {
      await expectDomainRejected(
        client,
        "update_affiliate_code",
        args,
        /between 0 and 100/
      );
    });

    it("update_affiliate_code accepts a percent value at the 100 boundary", async () => {
      await expectPassedValidation(client, "update_affiliate_code", {
        codeId: 1,
        rebateType: "percent",
        rebateValue: 100,
      });
    });

    it.each([
      [
        "percent shippingDiscountValue above 100",
        {
          enabled: true,
          discountPercentage: 10,
          shippingDiscountType: "percent",
          shippingDiscountValue: 150,
        },
        /between 1 and 100/,
      ],
      [
        "percent shippingDiscountValue of zero",
        {
          enabled: true,
          discountPercentage: 10,
          shippingDiscountType: "percent",
          shippingDiscountValue: 0,
        },
        /between 1 and 100/,
      ],
      [
        "fixed shippingDiscountValue of zero",
        {
          enabled: true,
          discountPercentage: 10,
          shippingDiscountType: "fixed",
          shippingDiscountValue: 0,
        },
        /greater than 0/,
      ],
    ])(
      "set_email_popup rejects %s (mirrors popup-capture validation)",
      async (_label, args, pattern) => {
        await expectDomainRejected(
          client,
          "set_email_popup",
          args as Record<string, unknown>,
          pattern as RegExp
        );
      }
    );

    it("set_email_popup accepts a percent shipping discount at the 100 boundary", async () => {
      await expectPassedValidation(client, "set_email_popup", {
        enabled: true,
        discountPercentage: 10,
        shippingDiscountType: "percent",
        shippingDiscountValue: 100,
      });
    });
  });
});
