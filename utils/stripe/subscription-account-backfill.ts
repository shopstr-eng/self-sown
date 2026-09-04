/**
 * One-time backfill engine: legacy subscriptions rows (created before the
 * connected_account_id column existed) carry NULL there, so cancel/update
 * resolve the seller's CURRENT Connect account at call time. For a seller who
 * disconnected and reconnected a different account, that targets the wrong
 * account and orphans the subscription.
 *
 * The fix is deliberately conservative: stamp the seller's current Connect
 * account ONLY after proving against Stripe that the subscription actually
 * exists on it. A subscription that doesn't retrieve under the current
 * account (resource_missing) is left NULL and counted for support — stamping
 * it would just move the orphaning, not fix it.
 *
 * Dependencies are injected so the engine is unit-testable; the script
 * wrapper (scripts/backfill-subscription-connected-accounts.ts) wires the
 * real db-service accessors and Stripe client.
 */

export interface LegacySubscriptionRow {
  stripe_subscription_id: string;
  seller_pubkey: string;
}

export interface SubscriptionAccountBackfillDeps {
  listLegacyRows: () => Promise<LegacySubscriptionRow[]>;
  getConnectAccount: (
    pubkey: string
  ) => Promise<{ stripe_account_id: string; charges_enabled: boolean } | null>;
  retrieveSubscription: (
    subscriptionId: string,
    stripeAccount: string
  ) => Promise<unknown>;
  /** Returns whether the row was actually stamped (false = already stamped). */
  stamp: (stripeSubscriptionId: string, accountId: string) => Promise<boolean>;
  /** When false, verify but never write (report-only mode). */
  apply: boolean;
  log?: (msg: string) => void;
}

export interface SubscriptionAccountBackfillReport {
  total: number;
  /** Subscription verified to exist on the seller's current account. */
  verified: number;
  /** Rows actually written (0 in report-only mode). */
  stamped: number;
  /** Seller has no Connect account row — nothing to verify against. */
  noConnectAccount: number;
  /** Not retrievable from the seller's current account — flag for support. */
  notOnCurrentAccount: number;
  /** Transient/unexpected retrieve failures — safe to re-run. */
  retrieveErrors: number;
}

function isResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

export async function backfillSubscriptionConnectedAccounts(
  deps: SubscriptionAccountBackfillDeps
): Promise<SubscriptionAccountBackfillReport> {
  const log = deps.log ?? (() => {});
  const report: SubscriptionAccountBackfillReport = {
    total: 0,
    verified: 0,
    stamped: 0,
    noConnectAccount: 0,
    notOnCurrentAccount: 0,
    retrieveErrors: 0,
  };

  const rows = await deps.listLegacyRows();
  report.total = rows.length;

  for (const row of rows) {
    const connect = await deps.getConnectAccount(row.seller_pubkey);
    // Existence verification only needs the account id — retrieving a
    // subscription works on restricted/disabled accounts too, and gating on
    // charges_enabled would leave those legacy rows permanently unstamped.
    if (!connect) {
      report.noConnectAccount++;
      log(
        `SKIP ${row.stripe_subscription_id}: seller ${row.seller_pubkey} has no Connect account`
      );
      continue;
    }

    try {
      await deps.retrieveSubscription(
        row.stripe_subscription_id,
        connect.stripe_account_id
      );
    } catch (err) {
      if (isResourceMissing(err)) {
        report.notOnCurrentAccount++;
        log(
          `NEEDS SUPPORT ${row.stripe_subscription_id}: not retrievable from seller's current account ${connect.stripe_account_id} — left NULL`
        );
      } else {
        report.retrieveErrors++;
        log(
          `ERROR ${row.stripe_subscription_id}: retrieve failed (${
            err instanceof Error ? err.message : String(err)
          }) — left NULL, safe to re-run`
        );
      }
      continue;
    }

    report.verified++;
    if (!deps.apply) {
      log(
        `WOULD STAMP ${row.stripe_subscription_id} -> ${connect.stripe_account_id}`
      );
      continue;
    }
    const didStamp = await deps.stamp(
      row.stripe_subscription_id,
      connect.stripe_account_id
    );
    if (didStamp) report.stamped++;
    log(
      `${didStamp ? "STAMPED" : "ALREADY STAMPED"} ${
        row.stripe_subscription_id
      } -> ${connect.stripe_account_id}`
    );
  }

  return report;
}
