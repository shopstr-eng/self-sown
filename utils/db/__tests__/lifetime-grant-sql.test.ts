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

  function lastSql(): string {
    return queryMock.mock.calls[0][0] as string;
  }

  it("runs exactly one statement and releases the client", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("passes the pubkey, billing method, and customer id as params", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_1",
    });

    expect(queryMock.mock.calls[0][1]).toEqual([
      "seller-pubkey",
      "stripe",
      "cus_1",
    ]);
  });

  it("defaults a missing customer id to null", async () => {
    await grantLifetimeMembership({
      pubkey: "seller-pubkey",
      billingMethod: "manual",
    });

    expect(queryMock.mock.calls[0][1]).toEqual([
      "seller-pubkey",
      "manual",
      null,
    ]);
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
