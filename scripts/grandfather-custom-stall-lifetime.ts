/**
 * Grandfather existing custom-stall sellers into a lifetime (Wrangler)
 * membership.
 *
 * Usage:
 *   pnpm tsx scripts/grandfather-custom-stall-lifetime.ts            # report only
 *   pnpm tsx scripts/grandfather-custom-stall-lifetime.ts --apply    # apply grants
 *
 * What it does:
 *   1. Collects every seller pubkey that owns a "custom stall" — i.e. has
 *      claimed a storefront URL: a registered slug in `shop_slugs` or a mapped
 *      custom domain in `custom_domains`.
 *   2. Reports each seller's current Pro membership state and the action that
 *      would be taken (grant lifetime / skip — already lifetime).
 *   3. With --apply, for each seller not already on lifetime:
 *        - cancels any live recurring Herd Stripe subscription so they're never
 *          charged again (best-effort; mirrors the lifetime-purchase flow), then
 *        - grants a never-expiring lifetime membership (billing_method 'manual',
 *          since this is a free grandfather grant, not a paid Stripe/manual sale).
 *      The lifetime upsert is keyed on pubkey, so re-running is idempotent.
 */
import { getDbPool } from "@/utils/db/db-service";
import {
  getProMembership,
  grantLifetimeMembership,
  listCustomStallPubkeys,
} from "@/utils/db/pro-membership";
import { cancelExistingProSubscription } from "@/utils/pro/membership";

function describeMembership(
  row: Awaited<ReturnType<typeof getProMembership>>
): string {
  if (!row) return "no membership";
  if (row.lifetime) return "lifetime";
  const recurring = row.stripe_subscription_id
    ? ` (recurring sub ${row.stripe_subscription_id})`
    : "";
  return `${row.status}${recurring}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pool = getDbPool();
  // Slug owners ∪ custom-domain owners = sellers with a custom stall. Shared with
  // the automatic one-time backfill (grandfatherCustomStallLifetimeOnce) so the
  // population is defined in exactly one place.
  const pubkeys = (await listCustomStallPubkeys()).sort();

  console.log(
    `\n=== Custom-stall sellers (${pubkeys.length}) ===` +
      (apply ? " [APPLY]" : " [report only]")
  );

  let granted = 0;
  let skipped = 0;
  let failed = 0;

  for (const pubkey of pubkeys) {
    let current;
    try {
      current = await getProMembership(pubkey);
    } catch (err) {
      failed += 1;
      console.log(`  ${pubkey}  membership lookup FAILED:`, err);
      continue;
    }

    if (current?.lifetime) {
      skipped += 1;
      console.log(`  ${pubkey}  ${describeMembership(current)}  -> skip`);
      continue;
    }

    if (!apply) {
      console.log(
        `  ${pubkey}  ${describeMembership(current)}  -> would grant lifetime`
      );
      granted += 1;
      continue;
    }

    try {
      // Stop any live recurring charge first (best-effort), then grant lifetime.
      await cancelExistingProSubscription(pubkey);
      await grantLifetimeMembership({ pubkey, billingMethod: "manual" });
      granted += 1;
      console.log(
        `  ${pubkey}  ${describeMembership(current)}  -> granted lifetime`
      );
    } catch (err) {
      failed += 1;
      console.log(`  ${pubkey}  grant FAILED:`, err);
    }
  }

  console.log(
    `\nDone. ${apply ? "granted" : "would grant"}=${granted} skipped=${skipped} failed=${failed}`
  );
  if (!apply && granted > 0) {
    console.log("(run with --apply to grant the lifetime memberships)");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
