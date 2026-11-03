/** @jest-environment node */

import type Stripe from "stripe";

import { ensureConnectAccountCapabilities } from "@/utils/stripe/ensure-capabilities";

// Minimal Stripe client double: just the two Accounts methods the util uses.
function makeStripeDouble(capabilities: Record<string, string>) {
  const update = jest.fn(async () => ({}));
  const stripe = {
    accounts: {
      retrieve: jest.fn(async () => ({
        id: "acct_test",
        type: "express",
        capabilities,
      })),
      update,
    },
  } as unknown as Stripe;
  return { stripe, update };
}

describe("ensureConnectAccountCapabilities", () => {
  it("requests tap_to_pay_payments for an account that predates it", async () => {
    // Sellers onboarded before Tap to Pay have card_payments/transfers but
    // no tap_to_pay_payments — the ensure seam must request it.
    const { stripe, update } = makeStripeDouble({
      card_payments: "active",
      transfers: "active",
    });
    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");
    expect(result).toEqual({
      ok: true,
      requested: ["tap_to_pay_payments"],
      alreadySatisfied: false,
    });
    expect(update).toHaveBeenCalledWith("acct_test", {
      capabilities: { tap_to_pay_payments: { requested: true } },
    });
  });

  it("does not re-request an active or pending capability", async () => {
    const { stripe, update } = makeStripeDouble({
      card_payments: "active",
      transfers: "active",
      tap_to_pay_payments: "pending",
    });
    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");
    expect(result).toEqual({
      ok: true,
      requested: [],
      alreadySatisfied: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns ok:false when the core capability request fails", async () => {
    // card_payments/transfers are non-negotiable: if that update fails the
    // seller genuinely cannot take card payments, so the failure is real.
    const stripe = {
      accounts: {
        retrieve: jest.fn(async () => ({
          id: "acct_test",
          type: "express",
          capabilities: {},
        })),
        update: jest.fn(async () => {
          throw new Error("Stripe API unavailable");
        }),
      },
    } as unknown as Stripe;
    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");
    expect(result.ok).toBe(false);
  });

  it("still requests core capabilities when Tap to Pay is rejected", async () => {
    // Tap to Pay is a gated platform feature: Stripe rejects the parameter
    // wholesale when the platform isn't enrolled ("Received unknown
    // parameter"). That rejection must not take the core capabilities down
    // with it — they used to share one accounts.update call (production
    // incident: card_payments/transfers stayed un-requested).
    const update = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Error(
          "Received unknown parameter: capabilities[tap_to_pay_payments]"
        )
      );
    const stripe = {
      accounts: {
        retrieve: jest.fn(async () => ({
          id: "acct_test",
          type: "express",
          capabilities: {},
        })),
        update,
      },
    } as unknown as Stripe;

    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");

    expect(result).toEqual({
      ok: true,
      requested: ["card_payments", "transfers"],
      alreadySatisfied: false,
      tapToPayError:
        "Received unknown parameter: capabilities[tap_to_pay_payments]",
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, "acct_test", {
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    expect(update).toHaveBeenNthCalledWith(2, "acct_test", {
      capabilities: { tap_to_pay_payments: { requested: true } },
    });
  });
});
