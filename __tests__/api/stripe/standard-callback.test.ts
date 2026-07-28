/** @jest-environment node */

// Route-level coverage for pages/api/stripe/connect/standard/callback.ts.
// The OAuth callback is UNAUTHENTICATED (the seller returns from Stripe), so
// the HMAC-signed state is the only thing binding it to a seller. Pinned:
//   1. A declined authorize redirects without exchanging anything.
//   2. A forged/missing state redirects with an error and NEVER exchanges the
//      code (or one Stripe account could be linked to a victim's pubkey).
//   3. A valid round-trip links the account as type "standard" — REPLACING
//      any existing (Express) row, which is the migration path.
//   4. A token-exchange failure redirects with an error and links nothing.

const oauthTokenMock = jest.fn();
const retrieveAccountMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    oauth: { token: (...a: unknown[]) => oauthTokenMock(...a) },
    accounts: { retrieve: (...a: unknown[]) => retrieveAccountMock(...a) },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/db/db-service", () => ({
  upsertStripeConnectAccount: jest.fn(),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

import handler from "@/pages/api/stripe/connect/standard/callback";
import { upsertStripeConnectAccount } from "@/utils/db/db-service";
import { createOAuthState } from "@/utils/stripe/standard-oauth";

const mockedUpsert = upsertStripeConnectAccount as jest.Mock;
const PUBKEY = "a".repeat(64);

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    redirectTo: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(url: string) {
      this.redirectTo = url;
      return this;
    },
  };
  return res;
}

async function callHandler(query: Record<string, unknown>) {
  const res = makeRes();
  await handler({ method: "GET", query } as any, res as any);
  return res;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_1";
  process.env.STRIPE_CLIENT_ID = "ca_test_1";
  process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market";
  oauthTokenMock.mockResolvedValue({ stripe_user_id: "acct_standard_1" });
  retrieveAccountMock.mockResolvedValue({
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/stripe/connect/standard/callback", () => {
  it("redirects with 'declined' when the seller cancelled at Stripe, exchanging nothing", async () => {
    const res = await callHandler({ error: "access_denied", state: "x" });
    expect(res.redirectTo).toBe("/settings/payments?stripe=standard-declined");
    expect(oauthTokenMock).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it("rejects a forged state without exchanging the code", async () => {
    const res = await callHandler({ code: "authcode_1", state: "forged.sig" });
    expect(res.redirectTo).toBe("/settings/payments?stripe=standard-error");
    expect(oauthTokenMock).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it("links the account as 'standard' on a valid round-trip", async () => {
    const state = createOAuthState(PUBKEY);
    const res = await callHandler({ code: "authcode_1", state });
    expect(res.redirectTo).toBe("/settings/payments?stripe=standard-success");
    expect(oauthTokenMock).toHaveBeenCalledWith({
      grant_type: "authorization_code",
      code: "authcode_1",
    });
    expect(mockedUpsert).toHaveBeenCalledWith(
      PUBKEY,
      "acct_standard_1",
      true,
      true,
      true,
      "standard"
    );
  });

  it("redirects with an error and links nothing when the token exchange fails", async () => {
    oauthTokenMock.mockRejectedValue(new Error("invalid code"));
    const state = createOAuthState(PUBKEY);
    const res = await callHandler({ code: "bad", state });
    expect(res.redirectTo).toBe("/settings/payments?stripe=standard-error");
    expect(mockedUpsert).not.toHaveBeenCalled();
  });
});
