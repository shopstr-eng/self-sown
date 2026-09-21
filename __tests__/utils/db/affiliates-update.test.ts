/**
 * Regression tests for updateAffiliate's no-op (empty patch) path.
 *
 * The empty-patch branch must:
 *  1. reuse the already-acquired pooled client — calling getAffiliateById
 *     would check out a SECOND client while the first is still held, and
 *     enough concurrent empty PATCHes would exhaust the pool (max 10) and
 *     stall all DB work;
 *  2. scope the read by seller_pubkey — an authenticated seller's empty
 *     PATCH must not read back another seller's affiliate by id.
 *
 * The db-service mock follows the pattern in affiliates.test.ts (importing
 * the real module transitively pulls in nostr-tools / @noble, which jest's
 * default transformer can't parse).
 */

const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(() => ({ query, release }));

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({ connect }),
}));

import { updateAffiliate } from "@/utils/db/affiliates";

describe("updateAffiliate empty-patch path", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    connect.mockClear();
  });

  it("uses the one already-held client, scoped to the seller", async () => {
    const row = { id: 7, seller_pubkey: "seller-a", name: "Alice" };
    query.mockResolvedValueOnce({ rows: [row] });

    const result = await updateAffiliate(7, "seller-a", {});

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/SELECT \* FROM affiliates/);
    expect(sql).toMatch(/seller_pubkey/);
    expect(params).toEqual([7, "seller-a"]);
    expect(result).toEqual(row);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns null when the affiliate belongs to another seller", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await updateAffiliate(7, "seller-b", {});

    expect(result).toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the client even when the read throws", async () => {
    query.mockRejectedValueOnce(new Error("db down"));

    await expect(updateAffiliate(7, "seller-a", {})).rejects.toThrow("db down");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
