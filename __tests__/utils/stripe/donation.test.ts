/** @jest-environment node */

// The ONE donation-percent contract shared by creation (recorded split
// fields) and every payout path (card transfers, recurring invoices): a
// seller-configured percent the settings UI permits must never make a PAID
// charge permanently unpayable, and rounding must never silently zero the
// seller or waive the fee.

jest.mock("@/utils/db/db-service", () => ({ getDbPool: jest.fn() }));

import { computeDonationCutSmallest } from "@/utils/stripe/donation";

describe("computeDonationCutSmallest — the shared creation/payout contract", () => {
  it("returns 0 for no or invalid donation", () => {
    expect(computeDonationCutSmallest(1000, 0)).toBe(0);
    expect(computeDonationCutSmallest(1000, NaN)).toBe(0);
    expect(computeDonationCutSmallest(1000, -5)).toBe(0);
    expect(computeDonationCutSmallest(0, 50)).toBe(0);
  });

  it("rounds the cut up within a partial percent", () => {
    expect(computeDonationCutSmallest(1125, 10)).toBe(113);
    expect(computeDonationCutSmallest(4000, 20)).toBe(800);
  });

  it("never lets rounding consume the whole payout at a partial percent", () => {
    // ceil(3 * 0.99) = 3 = gross — clamped so the seller keeps 1 unit and
    // the fee is not silently waived.
    expect(computeDonationCutSmallest(3, 99)).toBe(2);
    // A 1-unit gross can't be split — no fee is collectible.
    expect(computeDonationCutSmallest(1, 99)).toBe(0);
  });

  it("treats 100% (a UI-supported setting) as a full donation", () => {
    expect(computeDonationCutSmallest(4000, 100)).toBe(4000);
    expect(computeDonationCutSmallest(1, 100)).toBe(1);
    // Above-100 input (defensive; the profile lookup clamps to 100) behaves
    // the same as 100.
    expect(computeDonationCutSmallest(4000, 150)).toBe(4000);
  });
});
