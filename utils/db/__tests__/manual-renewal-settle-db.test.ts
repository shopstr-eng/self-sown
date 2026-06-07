/**
 * @jest-environment node
 */

// Real-database (Testcontainers) test for the manual (Bitcoin/fiat) NON-lifetime
// settle path: `settleProManualInvoiceAtomic` on a renewable monthly/yearly
// invoice (the common Pro renewal case).
//
// The mocked-pool tests only inspect MANUAL_EXTEND_SQL as a string. This file
// proves the actual transaction against a live Postgres, which is the only way
// to verify the parts a mock can't:
//   - the term stacks from GREATEST(now, current_period_end, trial_end) so an
//     EARLY renewal extends rather than truncates,
//   - the membership ends active with current_period_end / grace_until /
//     readonly_until set one term + grace + readonly out,
//   - the invoice ends paid with coverage_start/coverage_end stamped to the
//     exact term window (coverage_end = new period end; coverage_start one term
//     earlier), and
//   - a repeat settle of the same invoice is idempotent (already_settled, no
//     double-extension).
//
// Gated behind RUN_TESTCONTAINERS=1 like the harness in lifetime-settle-db.test
// so a machine without Docker still runs the rest of the suite.

export {};

jest.setTimeout(180000);

type DbServiceModule = typeof import("../db-service");
type ProMembershipModule = typeof import("../pro-membership");

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 7; // PRO_MANUAL_GRACE_DAYS
const READONLY_DAYS = 30; // PRO_READONLY_DAYS

function ms(value: string | Date | null): number {
  if (value === null) throw new Error("expected a timestamp, got null");
  return new Date(value).getTime();
}

async function withPostgresTestContainer<T>(
  callback: (databaseUrl: string) => Promise<T>
): Promise<T> {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");

  const container = await new PostgreSqlContainer("postgres:15-alpine")
    .withDatabase("shopstr")
    .withUsername("shopstr")
    .withPassword("shopstr")
    .start();

  try {
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const databaseUrl = `postgres://shopstr:shopstr@${host}:${port}/shopstr`;
    return await callback(databaseUrl);
  } finally {
    await container.stop();
  }
}

// Loads db-service AND pro-membership inside one isolated module context so they
// share the same connection pool (pro-membership imports getDbPool from
// db-service). Importing them separately would build two pools.
async function withProMembershipDb<T>(
  callback: (mods: {
    db: DbServiceModule;
    pro: ProMembershipModule;
  }) => Promise<T>
): Promise<T> {
  return withPostgresTestContainer(async (databaseUrl) => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    try {
      let result: T | undefined;
      await jest.isolateModulesAsync(async () => {
        jest.resetModules();
        jest.unmock("pg");
        const db = await import("../db-service");
        const pro = await import("../pro-membership");

        try {
          result = await callback({ db, pro });
        } finally {
          await db.closeDbPool();
        }
      });

      return result as T;
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });
}

async function waitForTables(
  db: DbServiceModule,
  tableNames: string[]
): Promise<void> {
  const deadline = Date.now() + 10000;
  const pool = db.getDbPool();

  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      const result = await client.query<{ tablename: string }>(
        `SELECT tablename
         FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename = ANY($1::text[])`,
        [tableNames]
      );

      if (result.rows.length === tableNames.length) {
        return;
      }
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
}

const maybeItTc = process.env.RUN_TESTCONTAINERS === "1" ? test : test.skip;

describe("settleProManualInvoiceAtomic — non-lifetime branch (real Postgres)", () => {
  maybeItTc(
    "settles a MONTHLY invoice: extends the membership one term + grace + readonly, stamps the coverage window onto the invoice, and is idempotent on retry",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "monthly-seller-pubkey";
        const invoiceId = "manual-monthly-invoice-1";

        const created = await pro.createProManualInvoice({
          invoiceId,
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 25000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });
        expect(created.lifetime).toBe(false);
        expect(created.status).toBe("pending");
        expect(created.membership_applied_at).toBeNull();

        const before = Date.now();
        const first = await pro.settleProManualInvoiceAtomic({ invoiceId });
        expect(first.outcome).toBe("settled");
        const after = Date.now();

        // Membership: active manual term with the full lapse timeline.
        const membership = await pro.getProMembership(pubkey);
        expect(membership).not.toBeNull();
        expect(membership!.lifetime).toBe(false);
        expect(membership!.status).toBe("active");
        expect(membership!.billing_method).toBe("manual");
        expect(membership!.term).toBe("monthly");
        expect(membership!.cancel_at_period_end).toBe(false);
        expect(membership!.current_period_end).not.toBeNull();
        expect(membership!.grace_until).not.toBeNull();
        expect(membership!.readonly_until).not.toBeNull();

        const periodEnd = ms(membership!.current_period_end);
        const graceUntil = ms(membership!.grace_until);
        const readonlyUntil = ms(membership!.readonly_until);

        // A fresh membership stacks from "now": one calendar month out (28-31d).
        expect(periodEnd - after).toBeGreaterThanOrEqual(28 * DAY_MS - DAY_MS);
        expect(periodEnd - before).toBeLessThanOrEqual(31 * DAY_MS + DAY_MS);

        // grace = period end + 7d; readonly = grace + 30d (exact day intervals).
        expect(graceUntil - periodEnd).toBe(GRACE_DAYS * DAY_MS);
        expect(readonlyUntil - graceUntil).toBe(READONLY_DAYS * DAY_MS);

        // Invoice: paid, applied, with the exact coverage window stamped.
        const settledInvoice = await pro.getProManualInvoice(invoiceId);
        expect(settledInvoice).not.toBeNull();
        expect(settledInvoice!.status).toBe("paid");
        expect(settledInvoice!.paid_at).not.toBeNull();
        expect(settledInvoice!.membership_applied_at).not.toBeNull();
        expect(settledInvoice!.coverage_start).not.toBeNull();
        expect(settledInvoice!.coverage_end).not.toBeNull();

        const coverageStart = ms(settledInvoice!.coverage_start);
        const coverageEnd = ms(settledInvoice!.coverage_end);

        // coverage_end == the membership's new period end.
        expect(coverageEnd).toBe(periodEnd);
        // coverage_start == period end minus one month == the base (~now).
        expect(coverageStart).toBeGreaterThanOrEqual(before - DAY_MS);
        expect(coverageStart).toBeLessThanOrEqual(after + DAY_MS);
        // The window spans one calendar month.
        expect(coverageEnd - coverageStart).toBeGreaterThanOrEqual(28 * DAY_MS);
        expect(coverageEnd - coverageStart).toBeLessThanOrEqual(31 * DAY_MS);

        const firstAppliedAt = settledInvoice!.membership_applied_at;
        const firstMembershipUpdatedAt = membership!.updated_at;

        // Second settle of the SAME invoice: idempotent, no double-extension.
        const second = await pro.settleProManualInvoiceAtomic({ invoiceId });
        expect(second.outcome).toBe("already_settled");

        const invoiceAfter = await pro.getProManualInvoice(invoiceId);
        expect(invoiceAfter!.membership_applied_at).toEqual(firstAppliedAt);
        expect(ms(invoiceAfter!.coverage_end)).toBe(coverageEnd);

        const membershipAfter = await pro.getProMembership(pubkey);
        // Period end untouched and the membership row was not rewritten.
        expect(ms(membershipAfter!.current_period_end)).toBe(periodEnd);
        expect(membershipAfter!.updated_at).toEqual(firstMembershipUpdatedAt);
      });
    }
  );

  maybeItTc(
    "settles a YEARLY invoice: extends one year + grace + readonly and stamps a one-year coverage window",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "yearly-seller-pubkey";
        const invoiceId = "manual-yearly-invoice-1";

        await pro.createProManualInvoice({
          invoiceId,
          pubkey,
          term: "yearly",
          method: "fiat",
          amountUsdCents: 15000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });

        const before = Date.now();
        const result = await pro.settleProManualInvoiceAtomic({ invoiceId });
        expect(result.outcome).toBe("settled");
        const after = Date.now();

        const membership = await pro.getProMembership(pubkey);
        expect(membership!.status).toBe("active");
        expect(membership!.term).toBe("yearly");
        expect(membership!.billing_method).toBe("manual");

        const periodEnd = ms(membership!.current_period_end);
        const graceUntil = ms(membership!.grace_until);
        const readonlyUntil = ms(membership!.readonly_until);

        // One year out (365-366 days), with the same grace/readonly tail.
        expect(periodEnd - after).toBeGreaterThanOrEqual(365 * DAY_MS - DAY_MS);
        expect(periodEnd - before).toBeLessThanOrEqual(366 * DAY_MS + DAY_MS);
        expect(graceUntil - periodEnd).toBe(GRACE_DAYS * DAY_MS);
        expect(readonlyUntil - graceUntil).toBe(READONLY_DAYS * DAY_MS);

        const settledInvoice = await pro.getProManualInvoice(invoiceId);
        const coverageStart = ms(settledInvoice!.coverage_start);
        const coverageEnd = ms(settledInvoice!.coverage_end);
        expect(coverageEnd).toBe(periodEnd);
        expect(coverageEnd - coverageStart).toBeGreaterThanOrEqual(
          365 * DAY_MS
        );
        expect(coverageEnd - coverageStart).toBeLessThanOrEqual(366 * DAY_MS);
      });
    }
  );

  maybeItTc(
    "an EARLY second renewal stacks on top of the first period end (extends, does not truncate)",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "stacking-seller-pubkey";

        // First monthly renewal establishes a period end ~1 month out.
        await pro.createProManualInvoice({
          invoiceId: "stack-invoice-1",
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 25000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });
        const firstSettle = await pro.settleProManualInvoiceAtomic({
          invoiceId: "stack-invoice-1",
        });
        expect(firstSettle.outcome).toBe("settled");

        const afterFirst = await pro.getProMembership(pubkey);
        const firstPeriodEnd = ms(afterFirst!.current_period_end);

        // Second monthly renewal paid EARLY, while the first term is still live.
        await pro.createProManualInvoice({
          invoiceId: "stack-invoice-2",
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 25000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });
        const secondSettle = await pro.settleProManualInvoiceAtomic({
          invoiceId: "stack-invoice-2",
        });
        expect(secondSettle.outcome).toBe("settled");

        const afterSecond = await pro.getProMembership(pubkey);
        const secondPeriodEnd = ms(afterSecond!.current_period_end);

        // It extended FROM the first period end, not from "now": the new end is
        // roughly a second month past the first end (28-31 days later), proving
        // the early renewal did not truncate the still-active first term.
        expect(secondPeriodEnd).toBeGreaterThan(firstPeriodEnd);
        expect(secondPeriodEnd - firstPeriodEnd).toBeGreaterThanOrEqual(
          28 * DAY_MS
        );
        expect(secondPeriodEnd - firstPeriodEnd).toBeLessThanOrEqual(
          31 * DAY_MS
        );

        // The second invoice's coverage window stacks on the first end too:
        // coverage_start ~= the first period end, coverage_end = new end.
        const secondInvoice = await pro.getProManualInvoice("stack-invoice-2");
        const coverageStart = ms(secondInvoice!.coverage_start);
        const coverageEnd = ms(secondInvoice!.coverage_end);
        expect(coverageEnd).toBe(secondPeriodEnd);
        expect(Math.abs(coverageStart - firstPeriodEnd)).toBeLessThanOrEqual(
          DAY_MS
        );
      });
    }
  );

  maybeItTc(
    "two renewals settled CONCURRENTLY both stack — final period end is base + exactly two terms, neither dropped nor double-counted, with distinct contiguous coverage windows",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "concurrent-seller-pubkey";

        // Two pending monthly invoices for the SAME seller, created before any
        // settle so neither has seen the other's period end.
        await pro.createProManualInvoice({
          invoiceId: "concurrent-invoice-1",
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 25000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });
        await pro.createProManualInvoice({
          invoiceId: "concurrent-invoice-2",
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 25000,
          dueAt: new Date(Date.now() + 7 * DAY_MS),
        });

        const before = Date.now();
        // Settle both AT THE SAME TIME. This is the exact race
        // MANUAL_EXTEND_SQL guards against: without the row-locked
        // GREATEST(now, current_period_end, trial_end) stacking, both
        // transactions could read the same prior period end (none) and each
        // write base + one term, dropping a paid month. The membership-row lock
        // serializes them so the second stacks on the first's committed end.
        const [r1, r2] = await Promise.all([
          pro.settleProManualInvoiceAtomic({
            invoiceId: "concurrent-invoice-1",
          }),
          pro.settleProManualInvoiceAtomic({
            invoiceId: "concurrent-invoice-2",
          }),
        ]);
        const after = Date.now();

        // Both invoices actually settled (neither was rejected/idempotent).
        expect(r1.outcome).toBe("settled");
        expect(r2.outcome).toBe("settled");

        // Membership ends active with both terms stacked.
        const membership = await pro.getProMembership(pubkey);
        expect(membership).not.toBeNull();
        expect(membership!.status).toBe("active");
        expect(membership!.billing_method).toBe("manual");
        expect(membership!.term).toBe("monthly");

        const periodEnd = ms(membership!.current_period_end);
        const graceUntil = ms(membership!.grace_until);
        const readonlyUntil = ms(membership!.readonly_until);

        // The whole point: TWO terms are stacked from ~now, not one. Two
        // consecutive calendar months span 59-62 days; one month is only
        // 28-31. Anything <= ~31 days here would mean a renewal was dropped
        // (both wrote base+1mo), and anything >= ~93 days would mean one was
        // double-counted (base+3mo).
        expect(periodEnd - after).toBeGreaterThanOrEqual(59 * DAY_MS - DAY_MS);
        expect(periodEnd - before).toBeLessThanOrEqual(62 * DAY_MS + DAY_MS);

        // The lapse tail hangs off the (stacked) period end exactly as usual.
        expect(graceUntil - periodEnd).toBe(GRACE_DAYS * DAY_MS);
        expect(readonlyUntil - graceUntil).toBe(READONLY_DAYS * DAY_MS);

        // Both invoices are paid + applied, each with its own coverage window.
        const inv1 = await pro.getProManualInvoice("concurrent-invoice-1");
        const inv2 = await pro.getProManualInvoice("concurrent-invoice-2");
        expect(inv1!.status).toBe("paid");
        expect(inv2!.status).toBe("paid");
        expect(inv1!.membership_applied_at).not.toBeNull();
        expect(inv2!.membership_applied_at).not.toBeNull();
        expect(inv1!.coverage_start).not.toBeNull();
        expect(inv2!.coverage_start).not.toBeNull();

        // Order-independent: whichever committed first owns the earlier window.
        const windows = [
          { start: ms(inv1!.coverage_start), end: ms(inv1!.coverage_end) },
          { start: ms(inv2!.coverage_start), end: ms(inv2!.coverage_end) },
        ].sort((a, b) => a.start - b.start);
        const earlier = windows[0]!;
        const later = windows[1]!;

        // Distinct windows: the two months don't overlap or collapse onto each
        // other (which is what a clobber would produce).
        expect(earlier.end).toBeLessThan(later.end);
        expect(earlier.start).toBeLessThan(later.start);

        // Contiguous: the second month begins exactly where the first ends, so
        // the seller paid for two back-to-back months with no gap or overlap.
        expect(Math.abs(later.start - earlier.end)).toBeLessThanOrEqual(DAY_MS);

        // The first month starts at ~now and the last window ends at the
        // membership's period end: together they cover [now, now + 2 terms].
        expect(earlier.start).toBeGreaterThanOrEqual(before - DAY_MS);
        expect(earlier.start).toBeLessThanOrEqual(after + DAY_MS);
        expect(later.end).toBe(periodEnd);
      });
    }
  );
});

describe("grantLifetimeMembership vs settleProManualInvoiceAtomic — cross-path race (real Postgres)", () => {
  maybeItTc(
    "a lifetime grant and a manual renewal settle running CONCURRENTLY for the same seller never deadlock; the membership ends lifetime/active with no leftover pending invoice and no stacked term clobbering the grant",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        // Run the race several times with fresh sellers/invoices so both
        // interleavings get exercised — grant-first (the renewal aborts as
        // not_settleable against a canceled invoice) and settle-first (the
        // renewal commits a paid term, then the lifetime grant supersedes it).
        // Either order must avoid the lock-order cycle the comments in
        // pro-membership.ts call out: both paths lock the invoice row(s) FIRST
        // and the pro_memberships row LAST, so Postgres can't deadlock them.
        const ITERATIONS = 5;

        for (let i = 0; i < ITERATIONS; i++) {
          const pubkey = `race-seller-${i}`;
          const invoiceId = `race-renewal-invoice-${i}`;

          // A pending monthly renewal invoice the seller is mid-paying when a
          // lifetime (Wrangler) upgrade lands for the same seller.
          await pro.createProManualInvoice({
            invoiceId,
            pubkey,
            term: "monthly",
            method: "bitcoin",
            amountUsdCents: 1500,
            amountSats: 25000,
            dueAt: new Date(Date.now() + 7 * DAY_MS),
          });

          // Fire both at once. Neither may throw (a Postgres deadlock would
          // surface as a rejected promise here).
          const [grantResult, settleResult] = await Promise.allSettled([
            pro.grantLifetimeMembership({
              pubkey,
              billingMethod: "manual",
            }),
            pro.settleProManualInvoiceAtomic({ invoiceId }),
          ]);

          expect(grantResult.status).toBe("fulfilled");
          expect(settleResult.status).toBe("fulfilled");

          // The settle either committed before the grant (settled) or found the
          // invoice already canceled by the grant (not_settleable). Both are
          // legitimate, race-dependent outcomes; "already_settled"/"not_found"
          // must never happen here.
          if (settleResult.status === "fulfilled") {
            expect(["settled", "not_settleable"]).toContain(
              settleResult.value.outcome
            );
          }

          // Final membership state: the lifetime grant always wins. It is set
          // unconditionally (ON CONFLICT DO UPDATE SET lifetime = TRUE) and
          // clears the term + entire lapse timeline, so even if the renewal
          // committed a stacked term first, lifetime supersedes it.
          const membership = await pro.getProMembership(pubkey);
          expect(membership).not.toBeNull();
          expect(membership!.lifetime).toBe(true);
          expect(membership!.status).toBe("active");
          expect(membership!.term).toBeNull();
          expect(membership!.cancel_at_period_end).toBe(false);
          // No stacked renewal term left hanging off the lifetime grant.
          expect(membership!.current_period_end).toBeNull();
          expect(membership!.grace_until).toBeNull();
          expect(membership!.readonly_until).toBeNull();

          // The renewal invoice is never left pending: either canceled by the
          // grant (settle-aborted) or paid-but-superseded (settle-committed).
          const invoice = await pro.getProManualInvoice(invoiceId);
          expect(invoice).not.toBeNull();
          expect(invoice!.status).not.toBe("pending");
          expect(["canceled", "paid"]).toContain(invoice!.status);

          // And no pending manual invoice survives for this seller at all, so
          // nothing can later poll-settle a paid term onto the lifetime grant.
          const pool = db.getDbPool();
          const pending = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM pro_manual_invoices
              WHERE pubkey = $1 AND status = 'pending'`,
            [pubkey]
          );
          expect(pending.rows[0]!.count).toBe("0");
        }
      });
    }
  );
});

describe("settleProManualInvoiceAtomic — lifetime vs renewal in-settle race (real Postgres)", () => {
  maybeItTc(
    "a pending lifetime invoice and a pending renewal invoice for the same seller, both settled CONCURRENTLY through settleProManualInvoiceAtomic, never deadlock; the membership ends lifetime/active with the term + entire lapse timeline cleared (no stacked term clobbers the grant) and no pending invoice survives",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        // Run the race several times with fresh sellers/invoices so both
        // interleavings get exercised through the SAME settle entry point:
        //   - lifetime-first: its cancel-others UPDATE flips the renewal to
        //     'canceled' before the renewal's FOR UPDATE select reads it, so the
        //     renewal settle returns not_settleable; and
        //   - renewal-first: the renewal commits a paid term, then the lifetime
        //     branch (whose cancel-others UPDATE no longer matches the now-paid
        //     renewal) grants lifetime and supersedes the stacked term.
        // Both paths lock invoice rows FIRST and the pro_memberships row LAST
        // (the lifetime branch grants via LIFETIME_GRANT_SQL only after its
        // invoice updates; the renewal branch extends only after its FOR UPDATE
        // select), so the lock order can't cycle and Postgres can't deadlock.
        const ITERATIONS = 5;

        for (let i = 0; i < ITERATIONS; i++) {
          const pubkey = `insettle-race-seller-${i}`;
          const lifetimeInvoiceId = `insettle-lifetime-invoice-${i}`;
          const renewalInvoiceId = `insettle-renewal-invoice-${i}`;

          // A pending Wrangler lifetime invoice (no term) AND a pending monthly
          // renewal invoice, both open for the SAME seller at the same time.
          const lifetimeInvoice = await pro.createProManualInvoice({
            invoiceId: lifetimeInvoiceId,
            pubkey,
            term: null,
            lifetime: true,
            method: "bitcoin",
            amountUsdCents: 50000,
            amountSats: 800000,
            dueAt: new Date(Date.now() + 7 * DAY_MS),
          });
          expect(lifetimeInvoice.lifetime).toBe(true);
          expect(lifetimeInvoice.term).toBeNull();

          const renewalInvoice = await pro.createProManualInvoice({
            invoiceId: renewalInvoiceId,
            pubkey,
            term: "monthly",
            method: "bitcoin",
            amountUsdCents: 1500,
            amountSats: 25000,
            dueAt: new Date(Date.now() + 7 * DAY_MS),
          });
          expect(renewalInvoice.lifetime).toBe(false);

          // Settle BOTH at once through the single settle entry point. A
          // Postgres deadlock would surface here as a rejected promise.
          const [lifetimeResult, renewalResult] = await Promise.allSettled([
            pro.settleProManualInvoiceAtomic({ invoiceId: lifetimeInvoiceId }),
            pro.settleProManualInvoiceAtomic({ invoiceId: renewalInvoiceId }),
          ]);

          expect(lifetimeResult.status).toBe("fulfilled");
          expect(renewalResult.status).toBe("fulfilled");

          // The lifetime invoice always settles: it is never canceled by the
          // renewal path, and its branch grants lifetime unconditionally.
          if (lifetimeResult.status === "fulfilled") {
            expect(lifetimeResult.value.outcome).toBe("settled");
          }

          // The renewal either committed its paid term before the lifetime grant
          // (settled) or found itself canceled by the lifetime branch's
          // cancel-others sweep (not_settleable). Both are legitimate,
          // race-dependent; "already_settled"/"not_found" must never happen.
          if (renewalResult.status === "fulfilled") {
            expect(["settled", "not_settleable"]).toContain(
              renewalResult.value.outcome
            );
          }

          // Final membership state: lifetime always wins. LIFETIME_GRANT_SQL
          // sets lifetime = TRUE and clears the term plus the whole lapse
          // timeline, so even a renewal term committed first is superseded —
          // nothing is left stacked on top of the lifetime grant.
          const membership = await pro.getProMembership(pubkey);
          expect(membership).not.toBeNull();
          expect(membership!.lifetime).toBe(true);
          expect(membership!.status).toBe("active");
          expect(membership!.billing_method).toBe("manual");
          expect(membership!.term).toBeNull();
          expect(membership!.cancel_at_period_end).toBe(false);
          expect(membership!.current_period_end).toBeNull();
          expect(membership!.grace_until).toBeNull();
          expect(membership!.readonly_until).toBeNull();

          // The lifetime invoice ends paid + applied with no coverage window
          // (lifetime buys no bounded term).
          const settledLifetime =
            await pro.getProManualInvoice(lifetimeInvoiceId);
          expect(settledLifetime).not.toBeNull();
          expect(settledLifetime!.status).toBe("paid");
          expect(settledLifetime!.paid_at).not.toBeNull();
          expect(settledLifetime!.membership_applied_at).not.toBeNull();
          expect(settledLifetime!.coverage_start).toBeNull();
          expect(settledLifetime!.coverage_end).toBeNull();

          // The renewal invoice is never left pending: either canceled by the
          // lifetime branch or paid-but-superseded if it committed first.
          const settledRenewal =
            await pro.getProManualInvoice(renewalInvoiceId);
          expect(settledRenewal).not.toBeNull();
          expect(settledRenewal!.status).not.toBe("pending");
          expect(["canceled", "paid"]).toContain(settledRenewal!.status);

          // No pending manual invoice survives for this seller at all, so a
          // later poll-settle can't stack a paid term onto the lifetime grant.
          const pool = db.getDbPool();
          const pending = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM pro_manual_invoices
              WHERE pubkey = $1 AND status = 'pending'`,
            [pubkey]
          );
          expect(pending.rows[0]!.count).toBe("0");
        }
      });
    }
  );
});
