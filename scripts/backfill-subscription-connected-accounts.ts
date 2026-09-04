/**
 * Backfill connected_account_id for legacy subscriptions rows.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-subscription-connected-accounts.ts           # report only
 *   pnpm tsx scripts/backfill-subscription-connected-accounts.ts --apply   # stamp verified rows
 *
 * What it does:
 *   1. Lists every subscriptions row with connected_account_id IS NULL
 *      (rows created before the column existed).
 *   2. For each, resolves the seller's current Connect account and verifies
 *      at Stripe that the subscription actually exists on that account
 *      (stripe.subscriptions.retrieve with { stripeAccount }).
 *   3. With --apply, stamps the verified account id. Rows whose subscription
 *      is NOT on the seller's current account are left NULL and reported as
 *      NEEDS SUPPORT; transient retrieve errors are reported and safe to
 *      re-run (the stamp is conditional on connected_account_id IS NULL, so
 *      re-runs are idempotent).
 *
 * After backfill, cancel/update for those rows target the verified account
 * via the stored connected_account_id (see pages/api/stripe/cancel-subscription.ts).
 */
import Stripe from "stripe";
import {
  closeDbPool,
  getStripeConnectAccount,
  listSubscriptionsMissingConnectedAccount,
  stampSubscriptionConnectedAccount,
} from "@/utils/db/db-service";
import { backfillSubscriptionConnectedAccounts } from "@/utils/stripe/subscription-account-backfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2025-09-30.clover",
  });

  console.log(
    `\n=== Legacy subscriptions connected_account_id backfill ===` +
      (apply ? " [APPLY]" : " [report only]")
  );

  const report = await backfillSubscriptionConnectedAccounts({
    listLegacyRows: listSubscriptionsMissingConnectedAccount,
    getConnectAccount: getStripeConnectAccount,
    retrieveSubscription: (subscriptionId, stripeAccount) =>
      stripe.subscriptions.retrieve(subscriptionId, { stripeAccount }),
    stamp: stampSubscriptionConnectedAccount,
    apply,
    log: (msg) => console.log(msg),
  });

  console.log(
    `\nDone. total=${report.total} verified=${report.verified} ` +
      `stamped=${report.stamped} noConnectAccount=${report.noConnectAccount} ` +
      `needsSupport=${report.notOnCurrentAccount} retrieveErrors=${report.retrieveErrors}`
  );
  if (!apply && report.verified > 0) {
    console.log("Re-run with --apply to stamp the verified rows.");
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool().catch(() => undefined));
