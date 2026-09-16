/**
 * One-time sweep engine: disable the marketplace host's payment method domain
 * on every seller's CONNECTED Stripe account. Pre-rearchitecture checkout
 * code registered the platform marketplace host on connected accounts via
 * payment_method_domains.create, and those PMDs remain enabled — so a seller
 * whose account registered the domain back then can still render an Apple Pay
 * button on their marketplace stall page even though the platform-account PMD
 * is already disabled and new code never registers the marketplace host.
 *
 * Per account (platform secret key + Stripe-Account header): list PMDs for
 * the marketplace domain, set enabled=false on any that are still enabled.
 * The sweep is idempotent (disabling an already-disabled PMD is a skip, not
 * a write) and per-account failures are logged and counted, never aborting
 * the rest of the run — safe to re-run to pick up errored accounts.
 *
 * Dependencies are injected so the engine is unit-testable; the script
 * wrapper (scripts/sweep-marketplace-apple-pay-pmds.ts) wires the real
 * db-service accessor and Stripe client.
 */

export interface ConnectAccountRow {
  pubkey: string;
  stripe_account_id: string;
}

export interface PaymentMethodDomainRef {
  id: string;
  enabled: boolean;
}

export interface ApplePaySweepDeps {
  listAccounts: () => Promise<ConnectAccountRow[]>;
  /** All PMDs for the marketplace domain on one connected account. */
  listPaymentMethodDomains: (
    accountId: string
  ) => Promise<PaymentMethodDomainRef[]>;
  disablePaymentMethodDomain: (
    accountId: string,
    pmdId: string
  ) => Promise<void>;
  /** The marketplace host whose PMDs must be disabled (log only). */
  domain: string;
  /** When false, report what would be disabled without writing. */
  apply: boolean;
  log?: (msg: string) => void;
}

export interface ApplePaySweepReport {
  /** Rows in stripe_connect_accounts. */
  total: number;
  /** Distinct account ids actually swept (rows can share an account). */
  accounts: number;
  /** Accounts with no PMD for the marketplace domain. */
  noDomain: number;
  /** PMDs already disabled — idempotent skip. */
  alreadyDisabled: number;
  /** PMDs actually disabled (0 in report-only mode). */
  disabled: number;
  /** PMDs that would be disabled in --apply mode. */
  wouldDisable: number;
  /** Accounts whose list/update failed — safe to re-run. */
  errors: number;
}

export async function sweepMarketplaceApplePayPmds(
  deps: ApplePaySweepDeps
): Promise<ApplePaySweepReport> {
  const log = deps.log ?? (() => {});
  const report: ApplePaySweepReport = {
    total: 0,
    accounts: 0,
    noDomain: 0,
    alreadyDisabled: 0,
    disabled: 0,
    wouldDisable: 0,
    errors: 0,
  };

  const rows = await deps.listAccounts();
  report.total = rows.length;

  // A seller's pubkey can map to multiple historical rows, and multiple
  // sellers could in principle share an account id — sweep each account once.
  const seen = new Set<string>();
  const accounts: string[] = [];
  for (const row of rows) {
    if (seen.has(row.stripe_account_id)) continue;
    seen.add(row.stripe_account_id);
    accounts.push(row.stripe_account_id);
  }
  report.accounts = accounts.length;

  for (const accountId of accounts) {
    let pmds: PaymentMethodDomainRef[];
    try {
      pmds = await deps.listPaymentMethodDomains(accountId);
    } catch (err) {
      report.errors++;
      log(
        `ERROR ${accountId}: failed to list payment method domains (${
          err instanceof Error ? err.message : String(err)
        }) — safe to re-run`
      );
      continue;
    }

    if (pmds.length === 0) {
      report.noDomain++;
      log(`SKIP ${accountId}: no PMD for ${deps.domain}`);
      continue;
    }

    for (const pmd of pmds) {
      if (!pmd.enabled) {
        report.alreadyDisabled++;
        log(`SKIP ${accountId}: PMD ${pmd.id} already disabled`);
        continue;
      }
      if (!deps.apply) {
        report.wouldDisable++;
        log(`WOULD DISABLE ${accountId}: PMD ${pmd.id}`);
        continue;
      }
      try {
        await deps.disablePaymentMethodDomain(accountId, pmd.id);
        report.disabled++;
        log(`DISABLED ${accountId}: PMD ${pmd.id}`);
      } catch (err) {
        report.errors++;
        log(
          `ERROR ${accountId}: failed to disable PMD ${pmd.id} (${
            err instanceof Error ? err.message : String(err)
          }) — safe to re-run`
        );
      }
    }
  }

  return report;
}
