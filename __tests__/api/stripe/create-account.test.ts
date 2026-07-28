/** @jest-environment node */

// Route-level coverage for seller-country handling in
// pages/api/stripe/connect/create-account.ts. Stripe Express accounts cannot
// change country after creation, and omitting it silently defaults to the
// platform's country (US) — which forces non-US sellers through US-only
// onboarding (SSN, US bank). These tests pin:
//   1. A supported country is passed through to stripe.accounts.create.
//   2. No country defaults to US (legacy clients unchanged).
//   3. An unsupported country is rejected before Stripe is touched.

const createAccountMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    accounts: { create: (...a: unknown[]) => createAccountMock(...a) },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: jest.fn(),
  upsertStripeConnectAccount: jest.fn(),
}));

jest.mock("@/utils/db/square-service", () => ({
  hasSquareConnection: jest.fn(async () => false),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  extractSignedEventFromRequest: jest.fn(() => null),
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

import handler from "@/pages/api/stripe/connect/create-account";
import { getStripeConnectAccount } from "@/utils/db/db-service";

const mockedGetAccount = getStripeConnectAccount as jest.Mock;
const PUBKEY = "a".repeat(64);

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function callHandler(body: Record<string, unknown>) {
  const res = makeRes();
  await handler({ method: "POST", body } as any, res as any);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetAccount.mockResolvedValue(null);
  createAccountMock.mockResolvedValue({ id: "acct_new" });
});

describe("POST /api/stripe/connect/create-account — seller country", () => {
  it("passes the seller's country to Stripe", async () => {
    const res = await callHandler({ pubkey: PUBKEY, country: "gb" });
    expect(res.statusCode).toBe(200);
    expect(createAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "express", country: "GB" })
    );
  });

  it("rejects a missing country without touching Stripe (fail closed: the choice is irreversible)", async () => {
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("country_required");
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported country without touching Stripe", async () => {
    const res = await callHandler({ pubkey: PUBKEY, country: "XX" });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("unsupported_country");
    expect(createAccountMock).not.toHaveBeenCalled();
  });
});
