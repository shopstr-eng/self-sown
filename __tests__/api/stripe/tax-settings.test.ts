/** @jest-environment node */

// Route-level coverage for regional tax registrations in
// pages/api/stripe/connect/tax-settings.ts. The endpoint used to be US-only;
// these tests pin the regional behavior:
//   1. US states register via country_options.us.state (state_sales_tax) —
//      and the legacy `state`-only body still implies US.
//   2. Canadian provinces register via country_options.ca province_standard.
//   3. Every other supported country registers whole-country (type standard,
//      e.g. VAT) with no subdivision.
//   4. Unsupported countries / bogus regions are rejected before Stripe is
//      touched, and the status response no longer filters non-US
//      registrations out.

const createRegistrationMock = jest.fn();
const listRegistrationsMock = jest.fn();
const updateTaxSettingsMock = jest.fn();
const retrieveTaxSettingsMock = jest.fn();
const retrieveAccountMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    accounts: { retrieve: (...a: unknown[]) => retrieveAccountMock(...a) },
    tax: {
      registrations: {
        create: (...a: unknown[]) => createRegistrationMock(...a),
        list: (...a: unknown[]) => listRegistrationsMock(...a),
      },
      settings: {
        update: (...a: unknown[]) => updateTaxSettingsMock(...a),
        retrieve: (...a: unknown[]) => retrieveTaxSettingsMock(...a),
      },
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: jest.fn(),
  setStripeTaxEnabled: jest.fn(),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  extractSignedEventFromRequest: jest.fn(() => null),
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
}));

import handler from "@/pages/api/stripe/connect/tax-settings";
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
  mockedGetAccount.mockResolvedValue({
    stripe_account_id: "acct_1",
    charges_enabled: true,
    tax_enabled: true,
  });
  retrieveAccountMock.mockResolvedValue({
    company: { address: { country: "GB", line1: "1 High St" } },
  });
  updateTaxSettingsMock.mockResolvedValue({});
  retrieveTaxSettingsMock.mockResolvedValue({ status: "active" });
  listRegistrationsMock.mockResolvedValue({ data: [] });
  createRegistrationMock.mockResolvedValue({ id: "txr_1" });
});

describe("POST /api/stripe/connect/tax-settings — regional registrations", () => {
  it("registers a US state via state_sales_tax (legacy state-only body implies US)", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      state: "ca",
    });
    expect(res.statusCode).toBe(200);
    expect(createRegistrationMock).toHaveBeenCalledWith(
      {
        country: "US",
        country_options: { us: { state: "CA", type: "state_sales_tax" } },
        active_from: "now",
      },
      { stripeAccount: "acct_1" }
    );
  });

  it("registers a Canadian province via province_standard", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      country: "CA",
      region: "on",
    });
    expect(res.statusCode).toBe(200);
    expect(createRegistrationMock).toHaveBeenCalledWith(
      {
        country: "CA",
        country_options: {
          ca: {
            type: "province_standard",
            province_standard: { province: "ON" },
          },
        },
        active_from: "now",
      },
      { stripeAccount: "acct_1" }
    );
  });

  it("registers a whole country (VAT-style) with no subdivision", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      country: "GB",
    });
    expect(res.statusCode).toBe(200);
    expect(createRegistrationMock).toHaveBeenCalledWith(
      {
        country: "GB",
        country_options: { gb: { type: "standard" } },
        active_from: "now",
      },
      { stripeAccount: "acct_1" }
    );
  });

  it("rejects a bogus US state without touching Stripe", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      country: "US",
      region: "XX",
    });
    expect(res.statusCode).toBe(400);
    expect(createRegistrationMock).not.toHaveBeenCalled();
  });

  it("rejects a bogus Canadian province without touching Stripe", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      country: "CA",
      region: "XX",
    });
    expect(res.statusCode).toBe(400);
    expect(createRegistrationMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported country without touching Stripe", async () => {
    const res = await callHandler({
      pubkey: PUBKEY,
      action: "add_registration",
      country: "XX",
    });
    expect(res.statusCode).toBe(400);
    expect(createRegistrationMock).not.toHaveBeenCalled();
  });

  it("returns non-US registrations in status instead of filtering them out", async () => {
    listRegistrationsMock.mockResolvedValue({
      data: [
        {
          id: "txr_us",
          country: "US",
          status: "active",
          active_from: 1,
          expires_at: null,
          country_options: { us: { state: "CA" } },
        },
        {
          id: "txr_gb",
          country: "GB",
          status: "active",
          active_from: 1,
          expires_at: null,
          country_options: { gb: { type: "standard" } },
        },
        {
          id: "txr_ca",
          country: "CA",
          status: "active",
          active_from: 1,
          expires_at: null,
          country_options: {
            ca: { province_standard: { province: "ON" } },
          },
        },
      ],
    });
    const res = await callHandler({ pubkey: PUBKEY, action: "status" });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).registrations).toEqual([
      expect.objectContaining({ id: "txr_us", country: "US", state: "CA" }),
      expect.objectContaining({ id: "txr_gb", country: "GB", state: null }),
      expect.objectContaining({ id: "txr_ca", country: "CA", state: "ON" }),
    ]);
  });
});
