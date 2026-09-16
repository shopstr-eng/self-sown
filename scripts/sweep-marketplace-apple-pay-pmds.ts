/**
 * One-off sweep: disable the marketplace host's payment method domain on
 * every seller's CONNECTED Stripe account. Legacy checkout code registered
 * the marketplace host on connected accounts during past checkouts; those
 * per-account PMDs stay enabled until explicitly disabled, which lets an
 * Apple Pay button render on marketplace stall pages even though the
 * platform-account PMD is off and new code never registers the host.
 *
 * Usage:
 *   pnpm tsx scripts/sweep-marketplace-apple-pay-pmds.ts           # report only
 *   pnpm tsx scripts/sweep-marketplace-apple-pay-pmds.ts --apply   # set enabled=false
 *   pnpm tsx scripts/sweep-marketplace-apple-pay-pmds.ts --domain=shop.example.com
 *
 * Requires STRIPE_SECRET_KEY (platform key) and DATABASE_URL. The domain
 * defaults to the host of NEXT_PUBLIC_BASE_URL. Idempotent: already-disabled
 * PMDs are skipped; list/update failures are logged and counted, never
 * aborting the run — re-run to pick them up.
 */
import Stripe from "stripe";
import {
  closeDbPool,
  listStripeConnectAccounts,
} from "@/utils/db/db-service";
import { sweepMarketplaceApplePayPmds } from "@/utils/stripe/apple-pay-sweep";

function resolveDomain(): string {
  const flag = process.argv
    .find((arg) => arg.startsWith("--domain="))
    ?.slice("--domain=".length);
  const raw = flag || process.env.NEXT_PUBLIC_BASE_URL || "";
  if (!raw) {
    throw new Error(
      "No domain given: pass --domain=<host> or set NEXT_PUBLIC_BASE_URL"
    );
  }
  const host = raw.includes("://") ? new URL(raw).host : raw;
  // Port-strip + lowercase so the filter matches how the PMD was registered.
  return (host.split(":")[0] || "").toLowerCase();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const domain = resolveDomain();
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is required");
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-09-30.clover",
  });

  console.log(
    `\n=== Marketplace Apple Pay PMD sweep: ${domain} ===` +
      (apply ? " [APPLY]" : " [report only]")
  );

  const report = await sweepMarketplaceApplePayPmds({
    listAccounts: listStripeConnectAccounts,
    listPaymentMethodDomains: async (accountId) => {
      const pmds: Array<{ id: string; enabled: boolean }> = [];
      for await (const pmd of stripe.paymentMethodDomains.list(
        { domain_name: domain },
        { stripeAccount: accountId }
      )) {
        pmds.push({ id: pmd.id, enabled: pmd.enabled });
      }
      return pmds;
    },
    disablePaymentMethodDomain: async (accountId, pmdId) => {
      await stripe.paymentMethodDomains.update(
        pmdId,
        { enabled: false },
        { stripeAccount: accountId }
      );
    },
    domain,
    apply,
    log: (msg) => console.log(msg),
  });

  console.log(
    `\nDone. rows=${report.total} accounts=${report.accounts} ` +
      `noDomain=${report.noDomain} alreadyDisabled=${report.alreadyDisabled} ` +
      `disabled=${report.disabled} wouldDisable=${report.wouldDisable} ` +
      `errors=${report.errors}`
  );
  if (!apply && report.wouldDisable > 0) {
    console.log("Re-run with --apply to disable them.");
  }
  // Non-zero exit so an operator/cron notices accounts that still need a
  // retry even though the sweep itself kept going.
  if (apply && report.errors > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Sweep failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool().catch(() => undefined));
