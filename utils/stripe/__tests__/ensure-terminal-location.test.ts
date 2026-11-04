/** @jest-environment node */

// ensureTerminalLocation: Tap to Pay dead-ends with "no Stripe Terminal
// location found on your account" until a location exists on the seller's
// CONNECTED account, and Express sellers can't create one (no Terminal
// dashboard). This seam reuses an existing location, creates one from the
// account's verified address (fallback: the seller's shipping origin), and
// memoizes per account so repeat taps add no Stripe latency.

import type Stripe from "stripe";

jest.mock("@/utils/db/db-service", () => ({
  getSellerShippingOrigin: jest.fn(async () => null),
}));

import {
  ensureTerminalLocation,
  resetTerminalLocationCacheForTests,
} from "@/utils/stripe/ensure-terminal-location";

const mockGetOrigin = jest.requireMock("@/utils/db/db-service")
  .getSellerShippingOrigin as jest.Mock;

const COMPANY_ACCOUNT = {
  company: {
    name: "Naughty Goat Creamery",
    address: {
      line1: "1 Farm Rd",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
      country: "US",
    },
  },
};

function makeStripeDouble(options: {
  locations?: Array<{ id: string }>;
  account?: Record<string, unknown>;
}) {
  const list = jest.fn(async () => ({ data: options.locations ?? [] }));
  const create = jest.fn(
    async (): Promise<{ id: string }> => ({ id: "tml_new" })
  );
  const retrieve = jest.fn(async () => options.account ?? {});
  const stripe = {
    accounts: { retrieve },
    terminal: { locations: { list, create } },
  } as unknown as Stripe;
  return { stripe, list, create, retrieve };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTerminalLocationCacheForTests();
  mockGetOrigin.mockResolvedValue(null);
});

describe("ensureTerminalLocation", () => {
  it("reuses an existing location and memoizes across calls", async () => {
    const { stripe, list, create } = makeStripeDouble({
      locations: [{ id: "tml_existing" }],
    });

    const first = await ensureTerminalLocation(stripe, "acct_test", "pk");
    const second = await ensureTerminalLocation(stripe, "acct_test", "pk");

    expect(first).toEqual({
      ok: true,
      locationId: "tml_existing",
      created: false,
    });
    expect(second).toEqual(first);
    // The repeat call is served from the memo — no second Stripe round-trip.
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a location from the account's company address when none exists", async () => {
    const { stripe, list, create } = makeStripeDouble({
      account: COMPANY_ACCOUNT,
    });

    const result = await ensureTerminalLocation(stripe, "acct_test", "pk");

    expect(result).toEqual({ ok: true, locationId: "tml_new", created: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      {
        display_name: "Naughty Goat Creamery",
        address: {
          line1: "1 Farm Rd",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      },
      { stripeAccount: "acct_test" }
    );
    expect(list).toHaveBeenCalledWith(
      { limit: 1 },
      {
        stripeAccount: "acct_test",
      }
    );
  });

  it("uses the individual address when the account has no company address", async () => {
    const { stripe, create } = makeStripeDouble({
      account: {
        individual: {
          first_name: "Jo",
          last_name: "Farmer",
          address: {
            line1: "22 Pasture Way",
            city: "Boise",
            state: "ID",
            postal_code: "83702",
            country: "US",
          },
        },
      },
    });

    const result = await ensureTerminalLocation(stripe, "acct_test", "pk");

    expect(result).toEqual({ ok: true, locationId: "tml_new", created: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: "Jo Farmer",
        address: expect.objectContaining({ line1: "22 Pasture Way" }),
      }),
      { stripeAccount: "acct_test" }
    );
  });

  it("falls back to the seller's shipping origin when the account has no address", async () => {
    mockGetOrigin.mockResolvedValue({
      from_name: "Jo",
      from_company: "Jo's Farm",
      from_street1: "9 Barn Ln",
      from_city: "Boise",
      from_state: "ID",
      from_zip: "83702",
      from_country: "US",
    });
    const { stripe, create } = makeStripeDouble({ account: {} });

    const result = await ensureTerminalLocation(stripe, "acct_test", "pk");

    expect(result).toEqual({ ok: true, locationId: "tml_new", created: true });
    expect(create).toHaveBeenCalledWith(
      {
        display_name: "Jo's Farm",
        address: {
          line1: "9 Barn Ln",
          city: "Boise",
          state: "ID",
          postal_code: "83702",
          country: "US",
        },
      },
      { stripeAccount: "acct_test" }
    );
  });

  it("fails with a clear no-address error when nothing is usable", async () => {
    // Partial addresses (missing postal_code) must NOT produce a location
    // Stripe would reject — the seller gets an actionable message instead.
    const { stripe, create } = makeStripeDouble({
      account: {
        company: {
          name: "Half There",
          address: { line1: "1 Farm Rd", city: "Austin", state: "TX" },
        },
      },
    });

    const result = await ensureTerminalLocation(stripe, "acct_test", "pk");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_address");
      expect(result.error).toContain("business address");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("shares one in-flight ensure across concurrent taps", async () => {
    const { stripe, list, create } = makeStripeDouble({
      account: COMPANY_ACCOUNT,
    });

    const [a, b] = await Promise.all([
      ensureTerminalLocation(stripe, "acct_test", "pk"),
      ensureTerminalLocation(stripe, "acct_test", "pk"),
    ]);

    expect(a).toEqual({ ok: true, locationId: "tml_new", created: true });
    expect(b).toEqual(a);
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures — the next attempt retries Stripe", async () => {
    const { stripe, list, create } = makeStripeDouble({
      account: COMPANY_ACCOUNT,
    });
    create.mockRejectedValueOnce(new Error("stripe down"));

    const first = await ensureTerminalLocation(stripe, "acct_test", "pk");
    expect(first).toEqual({
      ok: false,
      code: "stripe_error",
      error: "Could not set up the card reader location",
    });

    const second = await ensureTerminalLocation(stripe, "acct_test", "pk");
    expect(second).toEqual({ ok: true, locationId: "tml_new", created: true });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
