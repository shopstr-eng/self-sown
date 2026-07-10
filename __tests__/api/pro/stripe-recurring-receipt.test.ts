/** @jest-environment node */

// Receipt-CONTENT proof for recurring (Herd monthly/yearly) Stripe Pro renewals.
// The sibling `stripe-lifetime-receipt.test.ts` covers the one-time Wrangler
// lifetime PaymentIntent; the various `stripe-webhook-*` tests prove the webhook
// routes paid invoices into `sendProStripeReceiptEmail` — but none assert what the
// recurring receipt itself says. A bug in `sendProStripeReceiptEmail` (mapping the
// wrong term from the line item's recurring interval, reading the wrong amount
// field, dropping the hosted receipt/PDF links, or picking the wrong paid date)
// would still settle the renewal while mailing/DMing the seller a WRONG receipt.
//
// Here we run the REAL membership module and mock only its leaf dependencies, so
// we can drive a genuine paid monthly and yearly Stripe invoice through
// `sendProStripeReceiptEmail` and assert BOTH the email receipt (`sendProReceipt`)
// and the Nostr DM (`sendServerSideNostrDM`) carry `method: "stripe"`, the correct
// `term`, the cents amount taken from `invoice.amount_paid`, the hosted invoice
// url + PDF link, and the `paidAt` derived from `status_transitions.paid_at` (with
// a fallback to `invoice.created`). We also assert a zero-amount ($0 trial) invoice
// sends nothing.

const getProMembershipBySubscriptionMock = jest.fn();

const getSellerNotificationEmailMock = jest.fn();
const sendProReceiptMock = jest.fn();
const sendServerSideNostrDMMock = jest.fn();

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembershipBySubscription: (...args: unknown[]) =>
    getProMembershipBySubscriptionMock(...args),
  // Pulled in at module load but not driven by these tests.
  grantLifetimeMembership: jest.fn(),
  getProMembership: jest.fn(),
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

import { sendProStripeReceiptEmail } from "@/utils/pro/membership";
import type Stripe from "stripe";

// 1_700_000_000 → 2023-11-14T22:13:20.000Z.
const PAID_AT_UNIX = 1_700_000_000;
const CREATED_UNIX = 1_699_900_000; // earlier than paid_at, so we can prove paid_at wins.
const PAID_AT_ISO = new Date(PAID_AT_UNIX * 1000).toISOString();
const CREATED_ISO = new Date(CREATED_UNIX * 1000).toISOString();
// Mirror membership.ts's `formatReceiptDate` so the assertion is independent of
// the host timezone the test happens to run in.
const PAID_AT_DISPLAY = new Date(PAID_AT_ISO).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function recurringInvoice(
  interval: "month" | "year",
  overrides: Partial<Stripe.Invoice> = {}
) {
  return {
    id: "in_renewal",
    subscription: "sub_herd",
    amount_paid: interval === "year" ? 30000 : 3000,
    currency: "usd",
    created: CREATED_UNIX,
    status_transitions: { paid_at: PAID_AT_UNIX },
    hosted_invoice_url: "https://stripe.test/invoice/hosted",
    invoice_pdf: "https://stripe.test/invoice/pdf",
    lines: {
      data: [{ price: { recurring: { interval } } }],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

describe("sendProStripeReceiptEmail — recurring Herd renewal receipt content", () => {
  beforeEach(() => {
    getProMembershipBySubscriptionMock
      .mockReset()
      .mockResolvedValue({ pubkey: "seller-pubkey" });
    getSellerNotificationEmailMock.mockReset().mockResolvedValue(null);
    sendProReceiptMock.mockReset().mockResolvedValue(undefined);
    sendServerSideNostrDMMock.mockReset().mockResolvedValue(undefined);
  });

  it("emails a monthly renewal receipt: amount from amount_paid, stripe method, monthly term, hosted url + PDF, paidAt from paid_at", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProStripeReceiptEmail(recurringInvoice("month"));

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 3000,
        currency: "usd",
        term: "monthly",
        method: "stripe",
        paidAt: PAID_AT_ISO,
        receiptUrl: "https://stripe.test/invoice/hosted",
        invoicePdfUrl: "https://stripe.test/invoice/pdf",
      })
    );
  });

  it("DMs the monthly renewal details over Nostr (Herd Monthly plan, card method, amount, date, hosted receipt link)", async () => {
    await sendProStripeReceiptEmail(recurringInvoice("month"));

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [pubkey, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    expect(pubkey).toBe("seller-pubkey");
    // $30.00 = 3000 cents in USD; monthly → Herd (Monthly); stripe → card.
    expect(body).toContain("$30.00");
    expect(body).toContain("Plan: Herd (Monthly)");
    expect(body).toContain("Payment method: Card (Stripe)");
    expect(body).toContain(`Date: ${PAID_AT_DISPLAY}`);
    expect(body).toContain("Receipt: https://stripe.test/invoice/hosted");
    // A recurring renewal is not a lifetime purchase.
    expect(body).not.toContain("never expires");
    expect(body).not.toContain("Wrangler");
    expect(subject).toBe("Milk Market - payment receipt ($30.00)");
  });

  it("emails a yearly renewal receipt: amount from amount_paid, yearly term", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProStripeReceiptEmail(recurringInvoice("year"));

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 30000,
        currency: "usd",
        term: "yearly",
        method: "stripe",
        paidAt: PAID_AT_ISO,
        receiptUrl: "https://stripe.test/invoice/hosted",
        invoicePdfUrl: "https://stripe.test/invoice/pdf",
      })
    );
  });

  it("DMs the yearly renewal details over Nostr (Herd Annual plan, card method, amount)", async () => {
    await sendProStripeReceiptEmail(recurringInvoice("year"));

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    // $300.00 = 30000 cents in USD; yearly → Herd (Annual).
    expect(body).toContain("$300.00");
    expect(body).toContain("Plan: Herd (Annual)");
    expect(body).toContain("Payment method: Card (Stripe)");
    expect(subject).toBe("Milk Market - payment receipt ($300.00)");
  });

  it("falls back to invoice.created for paidAt when status_transitions.paid_at is absent", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProStripeReceiptEmail(
      recurringInvoice("month", {
        status_transitions: {} as Stripe.Invoice["status_transitions"],
      })
    );

    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({ paidAt: CREATED_ISO })
    );
  });

  it("DMs the renewal even when no notification email is on file (Nostr-first seller)", async () => {
    getSellerNotificationEmailMock.mockResolvedValue(null);

    await sendProStripeReceiptEmail(recurringInvoice("month"));

    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a zero-amount ($0 trial) invoice", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProStripeReceiptEmail(
      recurringInvoice("month", { amount_paid: 0 })
    );

    expect(getProMembershipBySubscriptionMock).not.toHaveBeenCalled();
    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).not.toHaveBeenCalled();
  });
});
