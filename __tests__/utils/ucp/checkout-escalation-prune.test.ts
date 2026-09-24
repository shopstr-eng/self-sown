/**
 * Retention for dead pre-order checkout-escalation rows
 * (utils/ucp/checkout-store.ts).
 *
 * The DB pool is mocked: these tests pin the prune CONTRACT — which rows the
 * DELETE targets (status + NULL order + updated_at cutoff), that failures
 * never escape into checkout, and that the request-path entry point is
 * interval-throttled — without needing a live Postgres.
 */

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({
    connect: async () => ({ query: mockQuery, release: mockRelease }),
  }),
  withSchemaDdlLock: jest.fn(),
}));

import {
  ESCALATION_SESSION_TTL_MS,
  maybePruneExpiredCheckoutEscalations,
  pruneExpiredCheckoutEscalations,
  resetCheckoutEscalationPruneThrottleForTests,
} from "@/utils/ucp/checkout-store";

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
  resetCheckoutEscalationPruneThrottleForTests();
});

describe("pruneExpiredCheckoutEscalations", () => {
  it("deletes only pre-order escalation rows untouched for the full TTL", async () => {
    mockQuery.mockResolvedValue({ rowCount: 3, rows: [] });
    const now = new Date("2026-09-24T12:00:00.000Z");

    const deleted = await pruneExpiredCheckoutEscalations(now);

    expect(deleted).toBe(3);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    // Pre-order escalations ONLY: a post-order escalation (mcp_order_id set)
    // references a real order whose payment may still need attention.
    expect(sql).toContain("status = 'requires_escalation'");
    expect(sql).toContain("mcp_order_id IS NULL");
    // The TTL clock is updated_at so an actively-retried session stays alive.
    expect(sql).toContain("updated_at < $1");
    expect(params[0].getTime()).toBe(
      now.getTime() - ESCALATION_SESSION_TTL_MS
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("uses a 30-day TTL", () => {
    expect(ESCALATION_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("swallows DB errors (returns 0) so a prune failure can't break checkout", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));

    await expect(pruneExpiredCheckoutEscalations()).resolves.toBe(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("treats a missing rowCount as 0 deletions", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(pruneExpiredCheckoutEscalations()).resolves.toBe(0);
  });
});

describe("maybePruneExpiredCheckoutEscalations", () => {
  it("prunes on the first call, then throttles to once per hour", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const t0 = Date.parse("2026-09-24T12:00:00.000Z");

    maybePruneExpiredCheckoutEscalations(t0);
    await flushMicrotasks();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // 59 minutes later: still within the interval — no second prune.
    maybePruneExpiredCheckoutEscalations(t0 + 59 * 60 * 1000);
    await flushMicrotasks();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // 61 minutes after the first prune: throttled window has passed.
    maybePruneExpiredCheckoutEscalations(t0 + 61 * 60 * 1000);
    await flushMicrotasks();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("never throws when the prune itself fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    expect(() => maybePruneExpiredCheckoutEscalations()).not.toThrow();
    await flushMicrotasks();
  });
});
