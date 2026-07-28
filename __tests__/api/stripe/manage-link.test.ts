/** @jest-environment node */

// Route-level coverage for the account-type guard in
// pages/api/stripe/connect/manage-link.ts. Express login/account links only
// exist for platform-hosted Express accounts; a seller-owned Standard account
// must be rejected with a clear pointer to the full Stripe dashboard instead
// of a cryptic Stripe API error.

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    accounts: { createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: jest.fn(),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  extractSignedEventFromRequest: jest.fn(() => null),
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/stripe/ensure-capabilities", () => ({
  ensureConnectAccountCapabilities: jest.fn(async () => {}),
}));

import handler from "@/pages/api/stripe/connect/manage-link";
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
});

describe("POST /api/stripe/connect/manage-link — account-type guard", () => {
  it("rejects standard accounts: no Express links exist for seller-owned accounts", async () => {
    mockedGetAccount.mockResolvedValue({
      stripe_account_id: "acct_1",
      account_type: "standard",
    });
    const res = await callHandler({
      pubkey: PUBKEY,
      accountId: "acct_1",
      mode: "dashboard",
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe("standard_account");
  });

  it("rejects an account id that doesn't belong to the seller", async () => {
    mockedGetAccount.mockResolvedValue({
      stripe_account_id: "acct_other",
      account_type: "express",
    });
    const res = await callHandler({
      pubkey: PUBKEY,
      accountId: "acct_1",
      mode: "dashboard",
    });
    expect(res.statusCode).toBe(403);
  });
});
