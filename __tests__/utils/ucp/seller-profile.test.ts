/**
 * profile_events keeps every version of a seller's profile. getSellerProfile
 * (used for payment-method discounts, fiat options, seller contact in the
 * shared order engine) must pick the NEWEST kind-30019 event — a bare .find()
 * could hand back a stale version or the kind-0 user profile.
 */

jest.mock("@/utils/db/db-service", () => ({
  fetchAllProductsFromDb: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  validateDiscountCode: jest.fn(),
  markDiscountCodeUsed: jest.fn(),
}));
jest.mock("@/mcp/tools/purchase-tools", () => ({
  createMcpOrder: jest.fn(),
  updateMcpOrderPayment: jest.fn(),
}));
jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(),
  deductStock: jest.fn(),
}));
jest.mock("@cashu/cashu-ts", () => ({ Mint: class {}, Wallet: class {} }));
jest.mock("stripe", () => jest.fn());

import { getSellerProfile } from "@/utils/ucp/order-service";
import { fetchAllProfilesFromDb } from "@/utils/db/db-service";

const seller = "a".repeat(64);

const makeEvent = (kind: number, created_at: number, content: object) => ({
  id: `${kind}-${created_at}`,
  kind,
  pubkey: seller,
  created_at,
  content: JSON.stringify(content),
  tags: [],
  sig: "sig",
});

describe("getSellerProfile", () => {
  it("returns the newest kind-30019 content, not an older duplicate or kind-0", async () => {
    (fetchAllProfilesFromDb as jest.Mock).mockResolvedValue([
      makeEvent(0, 500, { name: "user profile" }),
      makeEvent(30019, 100, { name: "old shop" }),
      makeEvent(30019, 300, { name: "newest shop" }),
      makeEvent(30019, 200, { name: "middle shop" }),
    ]);
    await expect(getSellerProfile(seller)).resolves.toEqual({
      name: "newest shop",
    });
  });

  it("falls back to the newest kind-0 when no shop profile exists", async () => {
    (fetchAllProfilesFromDb as jest.Mock).mockResolvedValue([
      makeEvent(0, 100, { name: "old" }),
      makeEvent(0, 200, { name: "new" }),
    ]);
    await expect(getSellerProfile(seller)).resolves.toEqual({ name: "new" });
  });

  it("returns null when the seller has no profile", async () => {
    (fetchAllProfilesFromDb as jest.Mock).mockResolvedValue([]);
    await expect(getSellerProfile(seller)).resolves.toBeNull();
  });
});
