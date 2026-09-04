/** @jest-environment node */

// Orchestration coverage for backfillManualCoverageOnce (task #42): the
// one-time backfill that replays the stacking reconstruction
// (computeManualCoverage) over a seller's paid manual invoices and stamps
// coverage_start/end onto rows settled before those columns existed. Pins:
// the one-shot pro_settings flag, oldest-first replay order (the DB helper
// returns DESC — the replay must sort), renewal stacking on the prior period
// end, trial-end participation, lifetime invoices contributing no window, and
// that only still-missing windows are written.

const mockGetProSetting = jest.fn();
const mockSetProSetting = jest.fn();
const mockListMissing = jest.fn();
const mockListPaid = jest.fn();
const mockSetCoverage = jest.fn();
const mockGetProMembership = jest.fn();

jest.mock("@/utils/db/pro-membership", () => ({
  grantLifetimeMembership: jest.fn(),
  getProMembership: (...args: unknown[]) => mockGetProMembership(...args),
  getProMembershipBySubscription: jest.fn(),
  applyProManualState: jest.fn(),
  applyProStripeState: jest.fn(),
  revokeProMembership: jest.fn(),
  syncProStripeMeta: jest.fn(),
  getProSetting: (...args: unknown[]) => mockGetProSetting(...args),
  setProSetting: (...args: unknown[]) => mockSetProSetting(...args),
  withProSettingsLock: (_key: string, fn: () => unknown) => fn(),
  grantProTrialIfMissing: jest.fn(),
  listExistingStallPubkeys: jest.fn(),
  listCustomStallPubkeys: jest.fn(),
  listPaidProManualInvoices: (...args: unknown[]) => mockListPaid(...args),
  listSettledManualInvoicesMissingCoverage: (...args: unknown[]) =>
    mockListMissing(...args),
  setProManualInvoiceCoverage: (...args: unknown[]) =>
    mockSetCoverage(...args),
}));

jest.mock("@/utils/pro/stripe-pro", () => ({
  getProStripe: jest.fn(),
  listProStripeInvoices: jest.fn(),
  mapStripeSubscription: jest.fn(),
}));

import { backfillManualCoverageOnce } from "@/utils/pro/membership";

const SELLER = "a".repeat(64);

function invoice(over: Record<string, unknown>) {
  return {
    id: 1,
    invoice_id: "inv_1",
    pubkey: SELLER,
    status: "paid",
    term: "monthly",
    lifetime: false,
    paid_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    coverage_start: null,
    coverage_end: null,
    ...over,
  } as any;
}

const iso = (d: unknown) => (d as Date).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetProSetting.mockResolvedValue(null);
  mockSetProSetting.mockResolvedValue(undefined);
  mockSetCoverage.mockResolvedValue(undefined);
  mockGetProMembership.mockResolvedValue(null);
  mockListPaid.mockResolvedValue([]);
  mockListMissing.mockResolvedValue([]);
});

describe("backfillManualCoverageOnce", () => {
  it("short-circuits when the one-shot flag is already set", async () => {
    mockGetProSetting.mockResolvedValue("2026-06-01T00:00:00.000Z");
    const result = await backfillManualCoverageOnce();
    expect(result).toEqual({ ran: false, filled: 0 });
    expect(mockListMissing).not.toHaveBeenCalled();
    expect(mockSetProSetting).not.toHaveBeenCalled();
  });

  it("replays oldest-first and stacks renewals on the prior period end", async () => {
    const inv1 = invoice({
      id: 1,
      invoice_id: "inv_1",
      paid_at: "2026-01-01T00:00:00.000Z",
    });
    const inv2 = invoice({
      id: 2,
      invoice_id: "inv_2",
      // Paid BEFORE inv1's term ends — an early renewal must extend the prior
      // term (Feb 1 → Mar 1), not restart from its own paid time.
      paid_at: "2026-01-15T00:00:00.000Z",
    });
    // The DB helper returns newest-first; the replay must re-sort.
    mockListPaid.mockResolvedValue([inv2, inv1]);
    mockListMissing.mockResolvedValue([inv1, inv2]);

    const result = await backfillManualCoverageOnce();

    expect(result).toEqual({ ran: true, filled: 2 });
    expect(mockSetCoverage).toHaveBeenCalledTimes(2);
    expect(mockSetCoverage).toHaveBeenCalledWith(
      "inv_1",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z")
    );
    expect(mockSetCoverage).toHaveBeenCalledWith(
      "inv_2",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z")
    );
    // The one-shot flag is stamped after the writes.
    expect(mockSetProSetting).toHaveBeenCalledWith(
      "manual_coverage_backfill_v1",
      expect.any(String)
    );
  });

  it("stacks on the trial end when it is later than the paid time", async () => {
    mockGetProMembership.mockResolvedValue({
      trial_end: "2026-02-01T00:00:00.000Z",
    });
    const inv1 = invoice({
      invoice_id: "inv_1",
      paid_at: "2026-01-10T00:00:00.000Z",
    });
    mockListPaid.mockResolvedValue([inv1]);
    mockListMissing.mockResolvedValue([inv1]);

    const result = await backfillManualCoverageOnce();

    expect(result).toEqual({ ran: true, filled: 1 });
    expect(mockSetCoverage).toHaveBeenCalledWith(
      "inv_1",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z")
    );
  });

  it("only writes invoices still missing coverage (replay uses the full paid list)", async () => {
    const inv1 = invoice({
      id: 1,
      invoice_id: "inv_1",
      paid_at: "2026-01-01T00:00:00.000Z",
      // Already stamped by the settle path — not in the missing list.
      coverage_start: "2026-01-01T00:00:00.000Z",
      coverage_end: "2026-02-01T00:00:00.000Z",
    });
    const inv2 = invoice({
      id: 2,
      invoice_id: "inv_2",
      paid_at: "2026-02-01T00:00:00.000Z",
    });
    mockListPaid.mockResolvedValue([inv2, inv1]);
    mockListMissing.mockResolvedValue([inv2]);

    const result = await backfillManualCoverageOnce();

    expect(result).toEqual({ ran: true, filled: 1 });
    // inv2's window still stacks on inv1's term even though inv1 needed no
    // write — the replay runs over ALL paid invoices.
    expect(mockSetCoverage).toHaveBeenCalledTimes(1);
    expect(mockSetCoverage).toHaveBeenCalledWith(
      "inv_2",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z")
    );
  });

  it("lifetime invoices contribute no coverage window to the stacking chain", async () => {
    const lifetimeInv = invoice({
      id: 1,
      invoice_id: "inv_life",
      term: null,
      lifetime: true,
      paid_at: "2026-01-05T00:00:00.000Z",
    });
    const inv1 = invoice({
      id: 2,
      invoice_id: "inv_1",
      paid_at: "2026-01-10T00:00:00.000Z",
    });
    mockListPaid.mockResolvedValue([inv1, lifetimeInv]);
    mockListMissing.mockResolvedValue([inv1]);

    const result = await backfillManualCoverageOnce();

    expect(result).toEqual({ ran: true, filled: 1 });
    // inv1 starts at its own paid time — the lifetime purchase must not push
    // the running period end.
    const [, start, end] = mockSetCoverage.mock.calls[0];
    expect(iso(start)).toBe("2026-01-10T00:00:00.000Z");
    expect(iso(end)).toBe("2026-02-10T00:00:00.000Z");
  });
});
