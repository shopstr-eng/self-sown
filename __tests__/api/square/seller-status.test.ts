/** @jest-environment node */

// Coverage for the buyer-facing Square seller-status route, focused on the
// Apple Pay countryCode path:
//
//   1. A stored location country is returned as countryCode with no extra
//      Square API calls.
//   2. A legacy connection without a country backfills it once from the
//      Square locations API (preferring the stored location id) and persists
//      it, so already-connected sellers get Apple Pay without reconnecting.
//   3. A backfill failure is non-fatal: card checkout still reports enabled,
//      countryCode is just absent (Apple Pay stays hidden).
//   4. The fail-closed shapes are unchanged: unknown sellers and unconfigured
//      deployments never touch the Square API.

const applyRateLimitMock = jest.fn();
const getSquareConnectionMock = jest.fn();
const updateSquareLocationCountryMock = jest.fn();
const getValidSquareAccessTokenMock = jest.fn();
const fetchSquareLocationsMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/db/square-service", () => ({
  getSquareConnection: (...args: unknown[]) => getSquareConnectionMock(...args),
  updateSquareLocationCountry: (...args: unknown[]) =>
    updateSquareLocationCountryMock(...args),
}));

// Keep pickPrimaryLocation real (pure selector the backfill falls back to),
// mock only the token + network calls.
jest.mock("@/utils/square/square-api", () => {
  const actual = jest.requireActual("@/utils/square/square-api");
  return {
    ...actual,
    getValidSquareAccessToken: (...args: unknown[]) =>
      getValidSquareAccessTokenMock(...args),
    fetchSquareLocations: (...args: unknown[]) =>
      fetchSquareLocationsMock(...args),
  };
});

jest.mock("@/utils/square/square-config", () => ({
  isSquareConfigured: () => true,
  getSquareApplicationId: () => "sandbox-sq0idb-test",
  getSquareEnvironment: () => "sandbox",
}));

import sellerStatusHandler from "@/pages/api/square/seller-status";

const PUBKEY = "b".repeat(64);

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

function makeConn(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: PUBKEY,
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: null,
    merchantId: "merch1",
    locationId: "loc-1",
    locationCurrency: "USD",
    locationCountry: "US",
    scope: "PAYMENTS_WRITE",
    status: "connected",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

async function call(body: unknown = { pubkey: PUBKEY }) {
  const req: any = { method: "POST", body, headers: {}, socket: {} };
  const res = makeRes();
  await sellerStatusHandler(req, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
});

describe("square seller-status countryCode", () => {
  it("returns the stored location country with no backfill calls", async () => {
    getSquareConnectionMock.mockResolvedValue(makeConn());
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.chargesEnabled).toBe(true);
    expect(res.body.countryCode).toBe("US");
    expect(fetchSquareLocationsMock).not.toHaveBeenCalled();
    expect(updateSquareLocationCountryMock).not.toHaveBeenCalled();
  });

  it("backfills a legacy connection's country from the stored location and persists it", async () => {
    getSquareConnectionMock.mockResolvedValue(
      makeConn({ locationCountry: null })
    );
    getValidSquareAccessTokenMock.mockResolvedValue({ accessToken: "tok" });
    fetchSquareLocationsMock.mockResolvedValue([
      {
        id: "loc-other",
        name: "Other",
        currency: "CAD",
        status: "ACTIVE",
        country: "CA",
      },
      {
        id: "loc-1",
        name: "Main",
        currency: "USD",
        status: "ACTIVE",
        country: "US",
      },
    ]);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.countryCode).toBe("US");
    expect(updateSquareLocationCountryMock).toHaveBeenCalledWith(PUBKEY, "US");
  });

  it("falls back to the primary (ACTIVE) location when the stored location id is gone", async () => {
    getSquareConnectionMock.mockResolvedValue(
      makeConn({ locationCountry: null })
    );
    getValidSquareAccessTokenMock.mockResolvedValue({ accessToken: "tok" });
    fetchSquareLocationsMock.mockResolvedValue([
      {
        id: "loc-inactive",
        name: "Old",
        currency: "USD",
        status: "INACTIVE",
        country: "GB",
      },
      {
        id: "loc-active",
        name: "New",
        currency: "USD",
        status: "ACTIVE",
        country: "US",
      },
    ]);
    const res = await call();
    expect(res.body.countryCode).toBe("US");
    expect(updateSquareLocationCountryMock).toHaveBeenCalledWith(PUBKEY, "US");
  });

  it("keeps card checkout enabled when the backfill fails", async () => {
    getSquareConnectionMock.mockResolvedValue(
      makeConn({ locationCountry: null })
    );
    getValidSquareAccessTokenMock.mockRejectedValue(new Error("square down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call();
    warn.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.chargesEnabled).toBe(true);
    expect(res.body.countryCode).toBeUndefined();
    expect(updateSquareLocationCountryMock).not.toHaveBeenCalled();
  });

  it("reports not-connected without probing tokens", async () => {
    getSquareConnectionMock.mockResolvedValue(null);
    const res = await call();
    expect(res.body).toEqual({
      configured: true,
      hasSquareAccount: false,
      chargesEnabled: false,
    });
    expect(getValidSquareAccessTokenMock).not.toHaveBeenCalled();
  });
});
