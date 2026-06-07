/** @jest-environment node */

// Receipt-CONTENT proof for the card (Stripe) Wrangler lifetime purchase. The
// sibling `stripe-webhook-lifetime-grant.test.ts` proves the webhook routes a
// one-time lifetime PaymentIntent down to `grantLifetimeMembership` with the
// right pubkey/billing method/customer id — but it never asserts what the
// receipt itself says. A bug in `applyStripeLifetimePayment` (reading the wrong
// amount field, dropping the `lifetime` flag, or sending the wrong currency)
// would still grant the upgrade while mailing/DMing the seller a WRONG receipt.
//
// Here we run the REAL membership module and mock only its leaf dependencies, so
// we can drive a genuine lifetime PaymentIntent through
// `applyStripeLifetimePayment` and assert BOTH the email receipt (`sendProReceipt`)
// and the Nostr DM (`sendServerSideNostrDM`) carry `lifetime: true`, `term: null`,
// `method: "stripe"`, the cents amount taken from `amount_received` (with a
// fallback to `amount`), the PaymentIntent currency, and the `paidAt` derived
// from `pi.created`.

const grantLifetimeMembershipMock = jest.fn();
const getProMembershipMock = jest.fn();
const cancelSubscriptionMock = jest.fn();

const getSellerNotificationEmailMock = jest.fn();
const sendProReceiptMock = jest.fn();
const sendServerSideNostrDMMock = jest.fn();

jest.mock("@/utils/db/pro-membership", () => ({
  grantLifetimeMembership: (...args: unknown[]) =>
    grantLifetimeMembershipMock(...args),
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
  // Pulled in at module load but not driven by these tests.
  getProMembershipBySubscription: jest.fn(),
  applyProStripeState: jest.fn(),
  syncProStripeMeta: jest.fn(),
  getProSetting: jest.fn(),
  setProSetting: jest.fn(),
  grantProTrialIfMissing: jest.fn(),
  listExistingStallPubkeys: jest.fn(),
  listPaidProManualInvoices: jest.fn(),
  listSettledManualInvoicesMissingCoverage: jest.fn(),
  setProManualInvoiceCoverage: jest.fn(),
}));

jest.mock("@/utils/pro/stripe-pro", () => {
  const actual = jest.requireActual("@/utils/pro/stripe-pro");
  return {
    ...actual,
    getProStripe: () => ({
      subscriptions: {
        cancel: (...args: unknown[]) => cancelSubscriptionMock(...args),
      },
    }),
  };
});

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: (...args: unknown[]) =>
    getSellerNotificationEmailMock(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendProReceipt: (...args: unknown[]) => sendProReceiptMock(...args),
  sendProLifetimeLingeringCancelAlert: jest.fn(),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: (...args: unknown[]) =>
    sendServerSideNostrDMMock(...args),
}));

import { applyStripeLifetimePayment } from "@/utils/pro/membership";
import type Stripe from "stripe";

// 1_700_000_000 → 2023-11-14T22:13:20.000Z.
const CREATED_UNIX = 1_700_000_000;
const PAID_AT_ISO = new Date(CREATED_UNIX * 1000).toISOString();
// Mirror membership.ts's `formatReceiptDate` so the assertion is independent of
// the host timezone the test happens to run in.
const PAID_AT_DISPLAY = new Date(PAID_AT_ISO).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function lifetimePI(overrides: Partial<Stripe.PaymentIntent> = {}) {
  return {
    id: "pi_lifetime",
    customer: "cus_wrangler",
    amount_received: 105000,
    amount: 105000,
    currency: "usd",
    created: CREATED_UNIX,
    metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

describe("applyStripeLifetimePayment — Wrangler lifetime receipt content", () => {
  beforeEach(() => {
    grantLifetimeMembershipMock.mockReset().mockResolvedValue(undefined);
    // No prior recurring subscription, so the at-purchase cancel is a no-op.
    getProMembershipMock
      .mockReset()
      .mockResolvedValue({ stripe_subscription_id: null });
    cancelSubscriptionMock.mockReset().mockResolvedValue({});

    getSellerNotificationEmailMock.mockReset().mockResolvedValue(null);
    sendProReceiptMock.mockReset().mockResolvedValue(undefined);
    sendServerSideNostrDMMock.mockReset().mockResolvedValue(undefined);
  });

  it("emails a lifetime receipt with amount from amount_received, stripe method, null term, and paidAt from pi.created", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await applyStripeLifetimePayment(lifetimePI());

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 105000,
        currency: "usd",
        term: null,
        method: "stripe",
        lifetime: true,
        paidAt: PAID_AT_ISO,
        receiptUrl: null,
        invoicePdfUrl: null,
      })
    );
  });

  it("DMs the same lifetime receipt details over Nostr (lifetime plan label, card method, amount, date)", async () => {
    await applyStripeLifetimePayment(lifetimePI());

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [pubkey, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    expect(pubkey).toBe("seller-pubkey");
    // $1050.00 = 105000 cents in USD; lifetime → Wrangler plan; stripe → card.
    expect(body).toContain("$1050.00");
    expect(body).toContain("Plan: Wrangler (Lifetime)");
    expect(body).toContain("Payment method: Card (Stripe)");
    expect(body).toContain("never expires");
    expect(body).toContain(`Date: ${PAID_AT_DISPLAY}`);
    // A lifetime purchase carries no recurring term, so no Herd plan line leaks.
    expect(body).not.toContain("Herd");
    expect(subject).toBe("Milk Market — payment receipt ($1050.00)");
  });

  it("DMs the receipt even when no notification email is on file (Nostr-first seller)", async () => {
    getSellerNotificationEmailMock.mockResolvedValue(null);

    await applyStripeLifetimePayment(lifetimePI());

    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to pi.amount for the cents amount when amount_received is absent", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await applyStripeLifetimePayment(
      lifetimePI({ amount_received: undefined as any, amount: 50000 })
    );

    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({ amountCents: 50000, lifetime: true })
    );
    const [, body] = sendServerSideNostrDMMock.mock.calls[0];
    expect(body).toContain("$500.00");
  });

  it("uses the PaymentIntent currency in the receipt (non-USD)", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await applyStripeLifetimePayment(
      lifetimePI({ currency: "eur", amount_received: 90000 } as any)
    );

    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({ currency: "eur", amountCents: 90000 })
    );
    const [, body] = sendServerSideNostrDMMock.mock.calls[0];
    // Non-USD formats as "<major> <CURRENCY>".
    expect(body).toContain("900.00 EUR");
  });
});
