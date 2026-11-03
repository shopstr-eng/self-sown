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
  it("requests core capabilities for an account missing them", async () => {
    const { stripe, update } = makeStripeDouble({});

    const result = await ensureConnectAccountCapabilities(stripe, "acct_test");

    expect(result).toEqual({
      ok: true,
      requested: ["card_payments", "transfers"],
      alreadySatisfied: false,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("acct_test", {
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
  });

  it("never requests tap_to_pay_payments — Tap to Pay rides on card_payments", async () => {
    // Regression guard: tap_to_pay_payments is not a real capability.
    // Requesting it 400s with "Received unknown parameter", and that 400
    // once sank card_payments/transfers in a shared accounts.update call.
    // (Verified live: a Tap to Pay charge succeeded on an account with only
    // card_payments active; confirmed by Stripe support.)
    const { stripe, update } = makeStripeDouble({});

    await ensureConnectAccountCapabilities(stripe, "acct_test");

    for (const call of update.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("tap_to_pay");
    }
  });

  it("does not re-request an active or pending capability", async () => {
    const { stripe, update } = makeStripeDouble({
      card_payments: "active",
      transfers: "pending",
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
});
