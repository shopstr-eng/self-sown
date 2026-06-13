/** @jest-environment node */

// Receipt-CONTENT proof for the MANUAL (Bitcoin/fiat) Wrangler lifetime
// purchase. The sibling `stripe-lifetime-receipt.test.ts` covers the card
// (Stripe) lifetime receipt built by `applyStripeLifetimePayment`; this file is
// its manual-path analogue, proving what `sendProManualReceiptEmail` puts on the
// receipt when a one-time lifetime invoice settles over Bitcoin or fiat.
//
// `sendProManualReceiptEmail` builds a `ProReceiptDetails` from the settled
// invoice row: `amountCents = invoice.amount_usd_cents`, `currency: "usd"`,
// `term: invoice.term`, `method: invoice.method`, `lifetime: invoice.lifetime`,
// and `paidAt` from `invoice.paid_at` (with a `now()` fallback when the just-
// settled row still has a null `paid_at`). A bug — reading the wrong amount
// field, dropping the `lifetime` flag, or sending the wrong method/term — would
// still grant the upgrade while mailing/DMing the seller a WRONG receipt.
//
// We run the REAL membership module and mock only its leaf dependencies so we
// can drive a genuine lifetime invoice through `sendProManualReceiptEmail` and
// assert BOTH the email receipt (`sendProReceipt`, only when a notification
// email is on file) and the Nostr DM (`sendServerSideNostrDM`) carry
// `lifetime: true`, `term: null`, the invoice's `method`, the cents amount taken
// from `amount_usd_cents`, and the correct `paidAt` (including the `now()`
// fallback when `paid_at` is null).

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

function lifetimeInvoice(
  overrides: Partial<ProManualInvoiceRow> = {}
): ProManualInvoiceRow {
  return {
    id: 1,
    invoice_id: "inv_lifetime",
    pubkey: "seller-pubkey",
    term: null,
    lifetime: true,
    method: "bitcoin",
    amount_usd_cents: 210000,
    amount_sats: 1_500_000,
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

describe("sendProManualReceiptEmail — manual lifetime receipt content", () => {
  beforeEach(() => {
    getSellerNotificationEmailMock.mockReset().mockResolvedValue(null);
    sendProReceiptMock.mockReset().mockResolvedValue(undefined);
    sendServerSideNostrDMMock.mockReset().mockResolvedValue(undefined);
  });

  it("emails a Bitcoin lifetime receipt with amount from amount_usd_cents, bitcoin method, null term, usd currency, paidAt from paid_at", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProManualReceiptEmail(lifetimeInvoice());

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({
        amountCents: 210000,
        currency: "usd",
        term: null,
        method: "bitcoin",
        lifetime: true,
        paidAt: PAID_AT_ISO,
        receiptUrl: null,
        invoicePdfUrl: null,
      })
    );
  });

  it("DMs the same lifetime receipt details over Nostr (lifetime plan label, bitcoin method, amount, date)", async () => {
    await sendProManualReceiptEmail(lifetimeInvoice());

    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
    const [pubkey, body, subject] = sendServerSideNostrDMMock.mock.calls[0];
    expect(pubkey).toBe("seller-pubkey");
    // $2100.00 = 210000 cents in USD; lifetime → Wrangler plan; bitcoin method.
    expect(body).toContain("$2100.00");
    expect(body).toContain("Plan: Wrangler (Lifetime)");
    expect(body).toContain("Payment method: Bitcoin");
    expect(body).toContain("never expires");
    expect(body).toContain(`Date: ${PAID_AT_DISPLAY}`);
    // A lifetime purchase carries no recurring term, so no Herd plan line leaks.
    expect(body).not.toContain("Herd");
    expect(subject).toBe("Milk Market — payment receipt ($2100.00)");
  });

  it("DMs the receipt even when no notification email is on file (Nostr-first seller)", async () => {
    getSellerNotificationEmailMock.mockResolvedValue(null);

    await sendProManualReceiptEmail(lifetimeInvoice());

    expect(sendProReceiptMock).not.toHaveBeenCalled();
    expect(sendServerSideNostrDMMock).toHaveBeenCalledTimes(1);
  });

  it("labels the receipt as Fiat when the invoice method is fiat", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    await sendProManualReceiptEmail(lifetimeInvoice({ method: "fiat" }));

    expect(sendProReceiptMock).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({ method: "fiat", lifetime: true, term: null })
    );
    const [, body] = sendServerSideNostrDMMock.mock.calls[0];
    expect(body).toContain("Payment method: Fiat");
    expect(body).toContain("Plan: Wrangler (Lifetime)");
  });

  it("falls back to now() for paidAt when the just-settled row still has a null paid_at", async () => {
    getSellerNotificationEmailMock.mockResolvedValue("seller@example.com");

    const before = Date.now();
    await sendProManualReceiptEmail(lifetimeInvoice({ paid_at: null }));
    const after = Date.now();

    expect(sendProReceiptMock).toHaveBeenCalledTimes(1);
    const [, details] = sendProReceiptMock.mock.calls[0];
    expect(details.lifetime).toBe(true);
    expect(details.paidAt).not.toBeNull();
    const paidMs = new Date(details.paidAt).getTime();
    expect(paidMs).toBeGreaterThanOrEqual(before);
    expect(paidMs).toBeLessThanOrEqual(after);
    // The DM carries the same now()-derived receipt.
    const [, body] = sendServerSideNostrDMMock.mock.calls[0];
    expect(body).toContain("$2100.00");
    expect(body).toContain("Plan: Wrangler (Lifetime)");
  });
});
