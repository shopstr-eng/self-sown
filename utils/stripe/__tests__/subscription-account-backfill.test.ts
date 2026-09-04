/** @jest-environment node */

import { backfillSubscriptionConnectedAccounts } from "../subscription-account-backfill";

const ROW = {
  stripe_subscription_id: "sub_legacy_1",
  seller_pubkey: "b".repeat(64),
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    listLegacyRows: jest.fn(async () => [ROW]),
    getConnectAccount: jest.fn(async () => ({
      stripe_account_id: "acct_current",
      charges_enabled: true,
    })),
    retrieveSubscription: jest.fn(async () => ({
      id: ROW.stripe_subscription_id,
    })),
    stamp: jest.fn(async () => true),
    apply: true,
    log: jest.fn(),
    ...overrides,
  };
}

describe("backfillSubscriptionConnectedAccounts", () => {
  it("stamps the verified current account when the subscription exists there", async () => {
    const deps = makeDeps();

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(deps.retrieveSubscription).toHaveBeenCalledWith(
      "sub_legacy_1",
      "acct_current"
    );
    expect(deps.stamp).toHaveBeenCalledWith("sub_legacy_1", "acct_current");
    expect(report).toMatchObject({ total: 1, verified: 1, stamped: 1 });
  });

  it("verifies but never writes in report-only mode", async () => {
    const deps = makeDeps({ apply: false });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(report.verified).toBe(1);
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(report.stamped).toBe(0);
  });

  it("leaves NULL and flags for support when the subscription is not on the current account", async () => {
    const deps = makeDeps({
      retrieveSubscription: jest.fn(async () => {
        throw Object.assign(new Error("No such subscription"), {
          code: "resource_missing",
          statusCode: 404,
        });
      }),
    });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(deps.stamp).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      verified: 0,
      stamped: 0,
      notOnCurrentAccount: 1,
    });
  });

  it("skips rows whose seller has no Connect account", async () => {
    const deps = makeDeps({
      getConnectAccount: jest.fn(async () => null),
    });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(deps.retrieveSubscription).not.toHaveBeenCalled();
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(report.noConnectAccount).toBe(1);
  });

  it("still verifies and stamps when the account is restricted (charges_enabled false)", async () => {
    // A restricted/disabled account still HOLDS the subscription — retrieving
    // it works fine, so gating verification on charges_enabled would leave
    // these rows permanently unstamped.
    const deps = makeDeps({
      getConnectAccount: jest.fn(async () => ({
        stripe_account_id: "acct_current",
        charges_enabled: false,
      })),
    });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(deps.retrieveSubscription).toHaveBeenCalledWith(
      "sub_legacy_1",
      "acct_current"
    );
    expect(deps.stamp).toHaveBeenCalledWith("sub_legacy_1", "acct_current");
    expect(report).toMatchObject({ verified: 1, stamped: 1 });
  });

  it("counts unexpected retrieve failures separately and leaves the row for a re-run", async () => {
    const deps = makeDeps({
      retrieveSubscription: jest.fn(async () => {
        throw new Error("stripe 500");
      }),
    });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(deps.stamp).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      verified: 0,
      notOnCurrentAccount: 0,
      retrieveErrors: 1,
    });
  });

  it("does not count a no-op stamp (concurrent writer) as stamped", async () => {
    const deps = makeDeps({ stamp: jest.fn(async () => false) });

    const report = await backfillSubscriptionConnectedAccounts(deps);

    expect(report).toMatchObject({ verified: 1, stamped: 0 });
  });
});
