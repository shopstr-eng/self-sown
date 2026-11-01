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

  it("treats a Stripe rejection (unsupported country) as non-fatal", async () => {
    const stripe = {
      accounts: {
        retrieve: jest.fn(async () => ({
          id: "acct_test",
          type: "express",
          capabilities: {},
        })),
        update: jest.fn(async () => {
          throw new Error(
            "capabilities.tap_to_pay_payments is not supported in this country"
          );
        }),
      },
    } as unknown as Stripe;
    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");
    expect(result.ok).toBe(false);
  });
});
