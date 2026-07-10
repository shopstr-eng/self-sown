// Contract test for LIFETIME_GRANT_SQL (exercised via grantLifetimeMembership).
// The SQL is the single source of truth that a lifetime (Wrangler) grant fully
// neutralizes any prior recurring state on conflict: it must clear `term`,
// `stripe_subscription_id`, and the entitlement timeline windows, set
// `lifetime = TRUE`, and preserve an existing customer id when none is passed.

const queryMock = jest.fn();
const releaseMock = jest.fn();
const connectMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({ connect: connectMock }),
}));

import { grantLifetimeMembership } from "@/utils/db/pro-membership";

describe("LIFETIME_GRANT_SQL via grantLifetimeMembership", () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
    releaseMock.mockReset();
    connectMock
      .mockReset()
      .mockResolvedValue({ query: queryMock, release: releaseMock });
  });

  // The grant now runs inside a transaction (BEGIN → cancel in-flight manual
  // invoices → LIFETIME_GRANT_SQL upsert → COMMIT), so locate the grant call by
  // its SQL rather than assuming it is the first statement.
  function grantCall(): unknown[] {
    const call = queryMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("ON CONFLICT (pubkey)")
    );
    if (!call) throw new Error("LIFETIME_GRANT_SQL was never executed");
    return call;
  }

  function lastSql(): string {
    return grantCall()[0] as string;
  }

  it("wraps the grant in a transaction and releases the client", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    const statements = queryMock.mock.calls.map((c) => c[0]);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("passes the pubkey, billing method, and customer id as params", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    expect(grantCall()[1]).toEqual(["seller-pubkey", "stripe", "cus_1"]);
  });

  it("defaults a missing customer id to null", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "manual",
    });

    expect(grantCall()[1]).toEqual(["seller-pubkey", "manual", null]);
  });

  it("upserts on the pubkey conflict and marks the row lifetime", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    const sql = lastSql();
    expect(sql).toMatch(/ON CONFLICT \(pubkey\) DO UPDATE/);
    expect(sql).toMatch(/lifetime = TRUE/);
    expect(sql).toMatch(/status = 'active'/);
  });

  it("clears the recurring term, subscription id, and entitlement timeline on conflict", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    const sql = lastSql();
    expect(sql).toMatch(/term = NULL/);
    expect(sql).toMatch(/stripe_subscription_id = NULL/);
    expect(sql).toMatch(/current_period_end = NULL/);
    expect(sql).toMatch(/grace_until = NULL/);
    expect(sql).toMatch(/readonly_until = NULL/);
    expect(sql).toMatch(/cancel_at_period_end = FALSE/);
  });

  it("clears reminder bookkeeping so a fresh lifetime grant never carries stale notices", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    const sql = lastSql();
    expect(sql).toMatch(/trial_reminder_sent_at = NULL/);
    expect(sql).toMatch(/due_reminder_sent_at = NULL/);
    expect(sql).toMatch(/readonly_notice_sent_at = NULL/);
    expect(sql).toMatch(/hidden_notice_sent_at = NULL/);
  });

  it("preserves an existing customer id when the grant carries none (COALESCE)", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "manual",
    });

    const sql = lastSql();
    expect(sql).toMatch(
      /stripe_customer_id\s*=\s*COALESCE\(EXCLUDED\.stripe_customer_id, pro_memberships\.stripe_customer_id\)/
    );
  });
});
