/** @jest-environment node */

// Marker coverage for the Pro membership paths a Stripe webhook drives when no
// local record matches. A Pro subscription/invoice with no membership row is
// permanent (retrying never manufactures the row), so the handlers return 200 —
// these tests pin the loud ORPHANED_* markers that are the only ops signal, and
// that a THROWN lookup (transient outage) still propagates so the webhook 500s
// and Stripe retries.

const getProMembershipBySubscriptionMock = jest.fn();
const getProMembershipMock = jest.fn();
const applyProStripeStateMock = jest.fn();
const syncProStripeMetaMock = jest.fn();
const getProSettingMock = jest.fn();
const getSellerNotificationEmailMock = jest.fn();
const sendProReceiptMock = jest.fn();
const sendServerSideNostrDMMock = jest.fn();
const sendOrphanedStripeEventAlertMock = jest.fn((..._args: unknown[]) =>
  Promise.resolve(true)
);

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembershipBySubscription: (...args: unknown[]) =>
    getProMembershipBySubscriptionMock(...args),
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
  applyProStripeState: (...args: unknown[]) => applyProStripeStateMock(...args),
  syncProStripeMeta: (...args: unknown[]) => syncProStripeMetaMock(...args),
  getProSetting: (...args: unknown[]) => getProSettingMock(...args),
  // Pulled in at module load but not driven by these tests.
  applyProManualState: jest.fn(),
  grantLifetimeMembership: jest.fn(),
  grantProTrialIfMissing: jest.fn(),
  revokeProMembership: jest.fn(),
  listCustomStallPubkeys: jest.fn(),
  listExistingStallPubkeys: jest.fn(),
  listPaidProManualInvoices: jest.fn(),
  listSettledManualInvoicesMissingCoverage: jest.fn(),
  setProManualInvoiceCoverage: jest.fn(),
  setProSetting: jest.fn(),
}));

jest.mock("@/utils/pro/stripe-pro", () => {
  const actual = jest.requireActual("@/utils/pro/stripe-pro");
  return {
    ...actual,
    getProStripe: () => ({
      subscriptions: { cancel: jest.fn() },
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
  sendOrphanedStripeEventAlert: (...args: unknown[]) =>
    (sendOrphanedStripeEventAlertMock as jest.Mock)(...args),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: (...args: unknown[]) =>
    sendServerSideNostrDMMock(...args),
}));

jest.mock("@/utils/self-host/config", () => ({
  isSelfHostTenant: jest.fn(() => false),
}));

import {
  applyStripeSubscriptionToMembership,
  sendProStripeReceiptEmail,
} from "@/utils/pro/membership";
import type Stripe from "stripe";

function proSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_orphan",
    customer: "cus_orphan",
    status: "active",
    metadata: { proMembership: "true" }, // Pro, but NO mmProPubkey
    items: { data: [] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function paidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_orphan_pro",
    subscription: "sub_orphan",
    amount_paid: 3000,
    currency: "usd",
    created: 1748606400,
    status_transitions: { paid_at: 1748606400 },
    lines: { data: [{ price: { recurring: { interval: "month" } } }] },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  jest.clearAllMocks();
  getProMembershipBySubscriptionMock.mockResolvedValue(null);
  getProMembershipMock.mockResolvedValue(null);
  getProSettingMock.mockResolvedValue(null);
  getSellerNotificationEmailMock.mockResolvedValue(null);
  sendProReceiptMock.mockResolvedValue(true);
  sendServerSideNostrDMMock.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

function errorLogText(): string {
  return (console.error as jest.Mock).mock.calls
    .map((args) => String(args[0]))
    .join("\n");
}

describe("applyStripeSubscriptionToMembership — orphaned Pro subscription", () => {
  it("logs ORPHANED_PRO_SUBSCRIPTION with the subscription, customer and event ids when nothing local matches", async () => {
    await applyStripeSubscriptionToMembership(proSubscription(), {
      eventId: "evt_orphan_pro",
    });

    expect(errorLogText()).toContain("ORPHANED_PRO_SUBSCRIPTION");
    expect(errorLogText()).toContain("sub_orphan");
    expect(errorLogText()).toContain("cus_orphan");
    expect(errorLogText()).toContain("evt_orphan_pro");
    // No entitlement state may be written for a subscription we cannot
    // attribute to a seller.
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
    // The marker is paired with a direct ops email so a human reconciles.
    expect(sendOrphanedStripeEventAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "ORPHANED_PRO_SUBSCRIPTION" })
    );
  });

  it("does not log the marker when pubkey metadata is present", async () => {
    getProMembershipMock.mockResolvedValue({ pubkey: "seller-pubkey" });

    await applyStripeSubscriptionToMembership(
      proSubscription({ metadata: { mmProPubkey: "seller-pubkey" } }),
      { eventId: "evt_ok" }
    );

    expect(errorLogText()).not.toContain("ORPHANED_PRO_SUBSCRIPTION");
    expect(sendOrphanedStripeEventAlertMock).not.toHaveBeenCalled();
  });
});

describe("sendProStripeReceiptEmail — orphaned Pro receipt", () => {
  it("logs ORPHANED_PRO_RECEIPT and sends nothing when no membership row matches", async () => {
    await sendProStripeReceiptEmail(paidInvoice(), {
      eventId: "evt_receipt_orphan",
    });

    expect(errorLogText()).toContain("ORPHANED_PRO_RECEIPT");
    expect(errorLogText()).toContain("sub_orphan");
    expect(errorLogText()).toContain("in_orphan_pro");
    expect(errorLogText()).toContain("evt_receipt_orphan");
    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).not.toHaveBeenCalled();
    // The marker is paired with a direct ops email so a human reconciles.
    expect(sendOrphanedStripeEventAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "ORPHANED_PRO_RECEIPT" })
    );
  });

  it("lets a thrown membership lookup propagate so the webhook 500s and Stripe retries", async () => {
    getProMembershipBySubscriptionMock.mockRejectedValue(new Error("db down"));

    await expect(sendProStripeReceiptEmail(paidInvoice())).rejects.toThrow(
      "db down"
    );
    expect(errorLogText()).not.toContain("ORPHANED_PRO_RECEIPT");
    expect(sendProReceiptMock).not.toHaveBeenCalled();
    // A thrown lookup is transient — no orphan alert may fire.
    expect(sendOrphanedStripeEventAlertMock).not.toHaveBeenCalled();
  });
});
