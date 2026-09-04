/** @jest-environment node */

// Claim-token fencing for stripe_processed_events: after a claim sits past the
// 15-minute stale window, a second worker (or Stripe retry) may reclaim the
// event. The first worker's failure path must NOT delete the second worker's
// live claim — that would let a third worker duplicate processing. These tests
// pin the token contract on claimStripeEvent/releaseStripeEvent with a
// stateful in-memory stand-in for the table.

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({
    connect: async () => ({ query: mockQuery, release: mockRelease }),
  }),
}));

import {
  claimStripeEvent,
  releaseStripeEvent,
} from "@/utils/stripe/processed-events";

type FakeRow = { event_id: string; claimed_at: number } | null;

function installStatefulTable(state: { row: FakeRow }) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const s = String(sql);
    const p = params as [string, string, number] & [string, number];
    if (s.includes("ON CONFLICT")) {
      state.row = { event_id: p[0], claimed_at: p[2] };
      return { rowCount: 1 };
    }
    if (s.includes("DELETE") && s.includes("claimed_at = $2")) {
      if (
        state.row &&
        state.row.event_id === p[0] &&
        state.row.claimed_at === p[1]
      ) {
        state.row = null;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }
    if (s.includes("DELETE")) {
      state.row = null;
      return { rowCount: 1 };
    }
    return { rowCount: 0 };
  });
}

describe("claimStripeEvent / releaseStripeEvent token fencing", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockRelease.mockReset();
  });

  it("returns a numeric claim token on success and null when deduped", async () => {
    installStatefulTable({ row: null });
    mockQuery.mockImplementation(async (sql: unknown) =>
      String(sql).includes("ON CONFLICT") ? { rowCount: 1 } : { rowCount: 0 }
    );

    const token = await claimStripeEvent("evt_a", "invoice.paid");

    expect(typeof token).toBe("number");

    mockQuery.mockImplementation(async (sql: unknown) =>
      String(sql).includes("ON CONFLICT") ? { rowCount: 0 } : { rowCount: 0 }
    );
    const dup = await claimStripeEvent("evt_a", "invoice.paid");
    expect(dup).toBeNull();
  });

  it("token-scoped release deletes WHERE claimed_at matches the token", async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0 }));

    await releaseStripeEvent("evt_b", 1234567890);

    const deleteCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM stripe_processed_events")
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain("claimed_at = $2");
    expect(deleteCall![1]).toEqual(["evt_b", 1234567890]);
  });

  it("a stale-reclaimed claim survives the OLD worker's release", async () => {
    const state: { row: FakeRow } = { row: null };
    installStatefulTable(state);
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000) // worker A claims
      .mockReturnValue(2_000); // worker B reclaims after the stale window

    const tokenA = await claimStripeEvent("evt_race", "invoice.paid");
    const tokenB = await claimStripeEvent("evt_race", "invoice.paid");
    nowSpy.mockRestore();

    expect(tokenA).toBe(1_000);
    expect(tokenB).toBe(2_000);
    expect(state.row!.claimed_at).toBe(2_000);

    // Worker A's error path releases with ITS token: B's live claim must stay.
    await releaseStripeEvent("evt_race", tokenA!);
    expect(state.row).not.toBeNull();
    expect(state.row!.claimed_at).toBe(2_000);

    // B's own release still works.
    await releaseStripeEvent("evt_race", tokenB!);
    expect(state.row).toBeNull();
  });

  it("token-less release stays the unconditional fallback", async () => {
    const state: { row: FakeRow } = {
      row: { event_id: "evt_c", claimed_at: 42 },
    };
    installStatefulTable(state);

    await releaseStripeEvent("evt_c");

    expect(state.row).toBeNull();
    const deleteCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM stripe_processed_events")
    );
    expect(String(deleteCall![0])).not.toContain("claimed_at = $2");
  });
});
