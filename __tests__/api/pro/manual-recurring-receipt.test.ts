/** @jest-environment node */

// Receipt-CONTENT proof for the MANUAL (Bitcoin/fiat) recurring Herd renewal.
// The sibling `manual-lifetime-receipt.test.ts` covers the one-time Wrangler
// LIFETIME receipt (lifetime:true, term:null) built by the SAME function,
// `sendProManualReceiptEmail`. This file is its recurring-renewal analogue: a
// settled manual invoice with `lifetime:false` and a `term` of "monthly" or
// "yearly".
//
// `sendProManualReceiptEmail` builds a `ProReceiptDetails` from the settled
// invoice row: `amountCents = invoice.amount_usd_cents`, `currency: "usd"`,
// `term: invoice.term`, `method: invoice.method`, `lifetime: invoice.lifetime`,
// and `paidAt` from `invoice.paid_at`. For a recurring renewal a bug — reading
// the wrong amount field, sending the wrong term, mislabeling the plan ("Herd
// (Monthly)" vs "Herd (Annual)"), leaking the lifetime "Wrangler"/"never
// expires" copy, or sending the wrong method — would still extend the
// membership while mailing/DMing the seller a WRONG renewal receipt.
//
// We run the REAL membership module and mock only its leaf dependencies so we
// can drive a genuine recurring invoice through `sendProManualReceiptEmail` and
// assert BOTH the email receipt (`sendProReceipt`, only when a notification
// email is on file) and the Nostr DM (`sendServerSideNostrDM`) carry
// `lifetime: false`, the correct `term`, the invoice's `method`, the cents
// amount taken from `amount_usd_cents`, `currency: "usd"`, and the right Herd
// plan label — with no "Wrangler"/"never expires" leakage.

const getSellerNotificationEmailMock = jest.fn();
const sendProReceiptMock = jest.fn();
const sendServerSideNostrDMMock = jest.fn();

jest.mock("@/utils/db/pro-membership", () => ({
  // Pulled in at module load but not driven by these tests.
  grantLifetimeMembership: jest.fn(),
  getProMembership: jest.fn(),
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
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: (...args: unknown[]) =>
    sendServerSideNostrDMMock(...args),
}));

import { sendProManualReceiptEmail } from "@/utils/pro/membership";
import type { ProManualInvoiceRow } from "@/utils/db/pro-membership";

// 2024-02-15T10:00:00.000Z — a stable settle time for the explicit-paid_at case.
const PAID_AT_ISO = "2024-02-15T10:00:00.000Z";
// Mirror membership.ts's `formatReceiptDate` so the assertion is independent of
// the host timezone the test happens to run in.
const PAID_AT_DISPLAY = new Date(PAID_AT_ISO).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function recurringInvoice(
  overrides: Partial<ProManualInvoiceRow> = {}
): ProManualInvoiceRow {
  return {
    id: 1,
    invoice_id: "inv_recurring",
    pubkey: "seller-pubkey",
    term: "monthly",
    lifetime: false,
    method: "bitcoin",
    amount_usd_cents: 1500,
    amount_sats: 25_000,
    bolt11: null,
    verify_url: null,
    payment_hash: null,
    status: "paid",
    due_at: PAID_AT_ISO,
    paid_at: PAID_AT_ISO,
    membership_applied_at: PAID_AT_ISO,
    coverage_start: null,
    coverage_end: null,
    created_at: PAID_AT_ISO,
    updated_at: PAID_AT_ISO,
    ...overrides,
  } as ProManualInvoiceRow;
}

describe("sendProManualReceiptEmail — manual recurring renewal receipt content", () => {
  beforeEach(() => {
    getSellerNotificationEmailMock.mockReset().mockResolvedValue(null);
    sendProReceiptMock.mockReset().mockResolvedValue(undefined);
    sendServerSideNostrDMMock.mockReset().mockResolvedValue(undefined);
  });

  it("emails a Bitcoin MONTHLY renewal receipt: amount from amount_usd_cents, bitcoin method, monthly term, usd currency, lifetime false, paidAt from paid_at", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProManualReceiptEmail(recurringInvoice());

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 1500,
        currency: "usd",
        term: "monthly",
        method: "bitcoin",
        lifetime: false,
        paidAt: PAID_AT_ISO,
        receiptUrl: null,
        invoicePdfUrl: null,
      })
    );
  });

  it("DMs the same MONTHLY renewal receipt over Nostr (Herd (Monthly) plan, bitcoin method, amount, date, no lifetime copy)", async () => {
    await sendProManualReceiptEmail(recurringInvoice());

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [pubkey, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    expect(pubkey).toBe("seller-pubkey");
    // $15.00 = 1500 cents in USD; monthly → Herd (Monthly); bitcoin method.
    expect(body).toContain("$15.00");
    expect(body).toContain("Plan: Herd (Monthly)");
    expect(body).toContain("Payment method: Bitcoin");
    expect(body).toContain(`Date: ${PAID_AT_DISPLAY}`);
    // A recurring renewal must not borrow the lifetime "Wrangler"/"never
    // expires" copy.
    expect(body).not.toContain("Wrangler");
    expect(body).not.toContain("never expires");
    expect(subject).toBe("Milk Market — payment receipt ($15.00)");
  });

  it("emails a Fiat YEARLY renewal receipt: amount from amount_usd_cents, fiat method, yearly term, lifetime false", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProManualReceiptEmail(
      recurringInvoice({
        term: "yearly",
        method: "fiat",
        amount_usd_cents: 15000,
      })
    );

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 15000,
        currency: "usd",
        term: "yearly",
        method: "fiat",
        lifetime: false,
        receiptUrl: null,
        invoicePdfUrl: null,
      })
    );
  });

  it("DMs the YEARLY renewal as Herd (Annual) with Fiat method and no lifetime copy", async () => {
    await sendProManualReceiptEmail(
      recurringInvoice({
        term: "yearly",
        method: "fiat",
        amount_usd_cents: 15000,
      })
    );

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    // $150.00 = 15000 cents in USD; yearly → Herd (Annual); fiat method.
    expect(body).toContain("$150.00");
    expect(body).toContain("Plan: Herd (Annual)");
    expect(body).toContain("Payment method: Fiat");
    expect(body).not.toContain("Herd (Monthly)");
    expect(body).not.toContain("Wrangler");
    expect(body).not.toContain("never expires");
    expect(subject).toBe("Milk Market — payment receipt ($150.00)");
  });

  it("DMs the renewal receipt even when no notification email is on file (Nostr-first seller)", async () => {
    getSellerNotificationEmailMock.mockResolvedValue(null);

    await sendProManualReceiptEmail(recurringInvoice());

    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [, body] = sendServerSideNostrDMMock.mock.calls[0];
    expect(body).toContain("Plan: Herd (Monthly)");
    expect(body).not.toContain("Wrangler");
  });
});
