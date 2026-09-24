/** @jest-environment node */

// Coverage for verifyCardPaymentForSeller — the fail-closed gate that lets an
// order confirmation send from a seller's own authenticated domain. The
// multi-merchant branch trusts server-written PaymentIntent metadata to prove
// seller membership: the compact `sellerSplitPubkeys` list (new) and the
// legacy full `sellerSplits` JSON (pre-cap-fix carts). Anything missing,
// malformed, or not naming the seller must verify FALSE.

const retrieveMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    paymentIntents: {
      retrieve: (...args: unknown[]) => retrieveMock(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: unknown[]) =>
    getStripeConnectAccountMock(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendOrderConfirmationToBuyer: jest.fn(),
  sendNewOrderToSeller: jest.fn(),
}));

jest.mock("@/utils/db/inventory-service", () => ({ deductStock: jest.fn() }));
jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(),
}));
jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({ applyRateLimit: jest.fn() }));
jest.mock("@/utils/messages/order-message-utils", () => ({
  resolveExplicitPaymentMethod: jest.fn(),
}));

import { verifyCardPaymentForSeller } from "@/pages/api/email/send-order-email";

const SELLER = "c".repeat(64);
const OTHER_SELLER = "d".repeat(64);
const PI_ID = "pi_test_123";
const BUYER = "buyer@example.com";

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  retrieveMock.mockReset();
  getStripeConnectAccountMock.mockReset();
  process.env.STRIPE_SECRET_KEY = "sk_test_platform";
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

// Seller has no connected account (or the direct-charge retrieve misses), so
// verification falls through to the platform-account PI metadata check.
function setupPlatformPi(metadata: Record<string, string>) {
  getStripeConnectAccountMock.mockResolvedValue(null);
  retrieveMock.mockResolvedValue({
    id: PI_ID,
    status: "succeeded",
    receipt_email: BUYER,
    metadata,
  });
}

describe("verifyCardPaymentForSeller — multi-merchant metadata", () => {
  it("verifies via the compact sellerSplitPubkeys list when the seller is named", async () => {
    setupPlatformPi({ sellerSplitPubkeys: `${SELLER},${OTHER_SELLER}` });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(true);
  });

  it("rejects when the compact list names only other sellers", async () => {
    setupPlatformPi({ sellerSplitPubkeys: OTHER_SELLER });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(false);
  });

  it("still verifies a legacy full sellerSplits JSON from pre-cap-fix carts", async () => {
    setupPlatformPi({
      sellerSplits: JSON.stringify([
        { pubkey: OTHER_SELLER, amountCents: 500 },
        { pubkey: SELLER, amountCents: 900 },
      ]),
    });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(true);
  });

  it("rejects malformed legacy JSON instead of throwing", async () => {
    setupPlatformPi({ sellerSplits: "{not json" });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(false);
  });

  it("rejects when neither membership key is present (fail closed)", async () => {
    setupPlatformPi({ isMultiMerchant: "true", transferGroup: "cart_x" });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(false);
  });

  it("rejects a payment whose receipt email does not match the buyer", async () => {
    getStripeConnectAccountMock.mockResolvedValue(null);
    retrieveMock.mockResolvedValue({
      id: PI_ID,
      status: "succeeded",
      receipt_email: "someone-else@example.com",
      metadata: { sellerSplitPubkeys: SELLER },
    });
    await expect(
      verifyCardPaymentForSeller({
        paymentIntentId: PI_ID,
        sellerPubkey: SELLER,
        buyerEmail: BUYER,
      })
    ).resolves.toBe(false);
  });
});
