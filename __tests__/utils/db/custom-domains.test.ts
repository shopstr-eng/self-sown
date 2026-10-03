/**
 * Resolution-order contract for seller share links: a verified custom domain
 * ALWAYS wins over the platform /stall/<slug> URL, which wins over the site
 * root. Every share-link surface (self-stats, emails, blog broadcasts, MCP
 * tools) routes through these helpers so the rule can't drift.
 */
import {
  resolveSellerCustomDomainUrl,
  resolveSellerStorefrontUrl,
} from "@/utils/db/custom-domains";
import { getShopSlugByPubkey } from "@/utils/db/db-service";

// getDbPool() runs at module scope in custom-domains.ts, so the factory must
// return a pool object; its query closure is only invoked inside tests.
const mockPoolQuery = jest.fn();
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
  getShopSlugByPubkey: jest.fn(),
}));

const PUBKEY = "a".repeat(64);
const getShopSlugMock = getShopSlugByPubkey as jest.Mock;

describe("resolveSellerStorefrontUrl", () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    mockPoolQuery.mockReset();
    getShopSlugMock.mockReset();
    process.env.NEXT_PUBLIC_BASE_URL = "https://test.example";
  });

  afterAll(() => {
    if (originalBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
  });

  it("returns the site root when the seller has neither slug nor domain", async () => {
    getShopSlugMock.mockResolvedValue(null);
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await expect(resolveSellerStorefrontUrl(PUBKEY)).resolves.toBe(
      "https://test.example"
    );
  });

  it("falls back to /stall/<slug> when there is no domain row", async () => {
    getShopSlugMock.mockResolvedValue("myshop");
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await expect(resolveSellerStorefrontUrl(PUBKEY)).resolves.toBe(
      "https://test.example/stall/myshop"
    );
  });

  it("prefers the verified custom domain over the stall slug", async () => {
    getShopSlugMock.mockResolvedValue("myshop");
    mockPoolQuery.mockResolvedValue({
      rows: [{ domain: "shop.example.com", verified: true }],
    });
    await expect(resolveSellerStorefrontUrl(PUBKEY)).resolves.toBe(
      "https://shop.example.com"
    );
  });

  it("ignores an unverified domain and uses the stall slug", async () => {
    getShopSlugMock.mockResolvedValue("myshop");
    mockPoolQuery.mockResolvedValue({
      rows: [{ domain: "shop.example.com", verified: false }],
    });
    await expect(resolveSellerStorefrontUrl(PUBKEY)).resolves.toBe(
      "https://test.example/stall/myshop"
    );
  });
});

describe("resolveSellerCustomDomainUrl", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("returns the https origin for a verified domain", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ domain: "shop.example.com", verified: true }],
    });
    await expect(resolveSellerCustomDomainUrl(PUBKEY)).resolves.toBe(
      "https://shop.example.com"
    );
  });

  it("returns null for an unverified domain", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ domain: "shop.example.com", verified: false }],
    });
    await expect(resolveSellerCustomDomainUrl(PUBKEY)).resolves.toBeNull();
  });

  it("returns null when there is no domain row", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await expect(resolveSellerCustomDomainUrl(PUBKEY)).resolves.toBeNull();
  });
});
