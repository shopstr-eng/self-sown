/** @jest-environment node */

/**
 * Key isolation for saved checkout sessions (utils/ucp/checkout-store.ts).
 *
 * Sessions are KEY-private, not account-wide: the api_key_id column is
 * written at insert, and every read/claim path must filter on it so one
 * agent key can never read or act on another key's sessions on the same
 * account. The DB pool is mocked: these tests pin the SQL contract — the
 * api_key_id predicate and bind order — so the filter can't be silently
 * dropped from a query rewrite.
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
  claimCheckoutSessionRetry,
  listCheckoutSessions,
} from "@/utils/ucp/checkout-store";

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe("listCheckoutSessions key isolation", () => {
  it("filters by api_key_id in addition to buyer_pubkey", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await listCheckoutSessions("pk-a", 7, 51, 10);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("buyer_pubkey = $1");
    expect(sql).toContain("api_key_id = $2");
    expect(params).toEqual(["pk-a", 7, 51, 10]);
  });

  it("a NULL api_key_id row can never match (fail-closed)", async () => {
    // The predicate is plain equality — NULL = anything is never true in
    // SQL, so legacy rows from before the column existed are invisible to
    // every key rather than visible to all of them. This test pins that the
    // query does NOT contain an `OR api_key_id IS NULL` escape hatch.
    mockQuery.mockResolvedValue({ rows: [] });

    await listCheckoutSessions("pk-a", 7, 50, 0);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/api_key_id IS NULL/i);
  });
});

describe("claimCheckoutSessionRetry key isolation", () => {
  it("scopes the atomic claim to the claiming key", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "ucp_cs_1" }] });

    const claimed = await claimCheckoutSessionRetry("ucp_cs_1", "pk-a", 7);

    expect(claimed).toEqual({ id: "ucp_cs_1" });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("api_key_id = $3");
    expect(sql).toContain("status = 'requires_escalation'");
    expect(params).toEqual(["ucp_cs_1", "pk-a", 7]);
  });

  it("another key's claim matches nothing (no cross-key retry)", async () => {
    // Same session id and pubkey, wrong key id → the UPDATE's WHERE matches
    // zero rows and the claim fails, exactly like a session that was already
    // claimed.
    mockQuery.mockResolvedValue({ rows: [] });

    const claimed = await claimCheckoutSessionRetry("ucp_cs_1", "pk-a", 8);

    expect(claimed).toBeNull();
  });
});
