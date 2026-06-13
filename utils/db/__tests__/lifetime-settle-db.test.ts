/**
 * @jest-environment node
 */

// Real-database (Testcontainers) test for the manual (Bitcoin/fiat) lifetime
// settle path: `settleProManualInvoiceAtomic` on a `lifetime: true` invoice.
//
// The Task #52 tests inspect LIFETIME_GRANT_SQL as a string against a mocked
// pool. This file proves the actual transaction against a live Postgres: the
// lifetime invoice flips to paid, stamps `membership_applied_at`, writes NO
// coverage window, and grants a never-expiring membership (lifetime = TRUE,
// active, with null term/period/grace/readonly). It also proves a second call
// is idempotent (`already_settled`, no double-apply).
//
// Gated behind RUN_TESTCONTAINERS=1 like the harness in db-service.test.ts so a
// machine without Docker still runs the rest of the suite.

jest.setTimeout(180000);

type DbServiceModule = typeof import("../db-service");
type ProMembershipModule = typeof import("../pro-membership");

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

describe("settleProManualInvoiceAtomic — lifetime branch (real Postgres)", () => {
  maybeItTc(
    "settles a lifetime invoice: grants never-expiring membership, stamps the invoice paid with no coverage window, and is idempotent on retry",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "lifetime-seller-pubkey";
        const invoiceId = "wrangler-lifetime-invoice-1";

        // A pending one-time Wrangler lifetime invoice (term is null).
        const created = await pro.createProManualInvoice({
          invoiceId,
          pubkey,
          term: null,
          lifetime: true,
          method: "bitcoin",
          amountUsdCents: 210000,
          amountSats: 1500000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        expect(created.lifetime).toBe(true);
        expect(created.status).toBe("pending");
        expect(created.membership_applied_at).toBeNull();

        // First settle: grants lifetime + flips the invoice paid in one txn.
        const first = await pro.settleProManualInvoiceAtomic({ invoiceId });
        expect(first.outcome).toBe("settled");

        // Membership row: never-expiring lifetime grant.
        const membership = await pro.getProMembership(pubkey);
        expect(membership).not.toBeNull();
        expect(membership!.lifetime).toBe(true);
        expect(membership!.status).toBe("active");
        expect(membership!.billing_method).toBe("manual");
        expect(membership!.term).toBeNull();
        expect(membership!.current_period_end).toBeNull();
        expect(membership!.grace_until).toBeNull();
        expect(membership!.readonly_until).toBeNull();
        expect(membership!.cancel_at_period_end).toBe(false);

        // Invoice row: paid, applied, NO coverage window.
        const settledInvoice = await pro.getProManualInvoice(invoiceId);
        expect(settledInvoice).not.toBeNull();
        expect(settledInvoice!.status).toBe("paid");
        expect(settledInvoice!.paid_at).not.toBeNull();
        expect(settledInvoice!.membership_applied_at).not.toBeNull();
        expect(settledInvoice!.coverage_start).toBeNull();
        expect(settledInvoice!.coverage_end).toBeNull();

        const firstAppliedAt = settledInvoice!.membership_applied_at;
        const firstMembershipUpdatedAt = membership!.updated_at;

        // Second settle: idempotent — reports already_settled and does not
        // re-apply (membership_applied_at unchanged, membership row untouched).
        const second = await pro.settleProManualInvoiceAtomic({ invoiceId });
        expect(second.outcome).toBe("already_settled");

        const invoiceAfter = await pro.getProManualInvoice(invoiceId);
        expect(invoiceAfter!.membership_applied_at).toEqual(firstAppliedAt);
        expect(invoiceAfter!.coverage_start).toBeNull();
        expect(invoiceAfter!.coverage_end).toBeNull();

        const membershipAfter = await pro.getProMembership(pubkey);
        expect(membershipAfter!.lifetime).toBe(true);
        expect(membershipAfter!.status).toBe("active");
        expect(membershipAfter!.term).toBeNull();
        // No second grant ran, so the membership row was not rewritten.
        expect(membershipAfter!.updated_at).toEqual(firstMembershipUpdatedAt);
      });
    }
  );

  maybeItTc(
    "settling a lifetime invoice cancels the seller's OTHER pending invoices but leaves historical paid/expired ones untouched",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "lifetime-seller-with-others";
        const otherPubkey = "unrelated-seller";

        const lifetimeInvoiceId = "wrangler-lifetime-invoice-2";
        const otherPendingInvoiceId = "herd-monthly-pending-1";
        const historicalPaidInvoiceId = "herd-yearly-paid-1";
        const historicalExpiredInvoiceId = "herd-monthly-expired-1";
        const otherSellerPendingInvoiceId = "other-seller-pending-1";

        // The lifetime invoice the seller is about to pay.
        await pro.createProManualInvoice({
          invoiceId: lifetimeInvoiceId,
          pubkey,
          term: null,
          lifetime: true,
          method: "bitcoin",
          amountUsdCents: 210000,
          amountSats: 1500000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // An OTHER still-open (pending) ordinary-term invoice for the SAME
        // seller — this is the stale Herd invoice that must be canceled so it
        // can't later stack a paid term on top of the never-expiring grant.
        await pro.createProManualInvoice({
          invoiceId: otherPendingInvoiceId,
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // A historical PAID invoice for the same seller — must be left alone.
        await pro.createProManualInvoice({
          invoiceId: historicalPaidInvoiceId,
          pubkey,
          term: "yearly",
          method: "bitcoin",
          amountUsdCents: 15000,
          amountSats: 210000,
          dueAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });

        // A historical EXPIRED invoice for the same seller — must be left alone.
        await pro.createProManualInvoice({
          invoiceId: historicalExpiredInvoiceId,
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });

        // A pending invoice belonging to a DIFFERENT seller — the cancel is
        // scoped by pubkey, so this must remain pending.
        await pro.createProManualInvoice({
          invoiceId: otherSellerPendingInvoiceId,
          pubkey: otherPubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // Move the two historical invoices into their settled/expired states.
        const pool = db.getDbPool();
        await pool.query(
          `UPDATE pro_manual_invoices
              SET status = 'paid',
                  paid_at = now(),
                  membership_applied_at = now()
            WHERE invoice_id = $1`,
          [historicalPaidInvoiceId]
        );
        await pool.query(
          `UPDATE pro_manual_invoices SET status = 'expired' WHERE invoice_id = $1`,
          [historicalExpiredInvoiceId]
        );

        // Settle the lifetime invoice.
        const result = await pro.settleProManualInvoiceAtomic({
          invoiceId: lifetimeInvoiceId,
        });
        expect(result.outcome).toBe("settled");

        // The lifetime invoice itself flips to paid.
        const lifetimeInvoice =
          await pro.getProManualInvoice(lifetimeInvoiceId);
        expect(lifetimeInvoice!.status).toBe("paid");
        expect(lifetimeInvoice!.membership_applied_at).not.toBeNull();

        // The OTHER pending invoice for this seller is canceled.
        const otherPending = await pro.getProManualInvoice(
          otherPendingInvoiceId
        );
        expect(otherPending!.status).toBe("canceled");
        // It was never settled, so no membership was applied to it.
        expect(otherPending!.membership_applied_at).toBeNull();

        // Historical paid invoice is untouched.
        const historicalPaid = await pro.getProManualInvoice(
          historicalPaidInvoiceId
        );
        expect(historicalPaid!.status).toBe("paid");

        // Historical expired invoice is untouched.
        const historicalExpired = await pro.getProManualInvoice(
          historicalExpiredInvoiceId
        );
        expect(historicalExpired!.status).toBe("expired");

        // The unrelated seller's pending invoice is untouched.
        const otherSellerPending = await pro.getProManualInvoice(
          otherSellerPendingInvoiceId
        );
        expect(otherSellerPending!.status).toBe("pending");

        // Membership is a never-expiring lifetime grant.
        const membership = await pro.getProMembership(pubkey);
        expect(membership!.lifetime).toBe(true);
        expect(membership!.status).toBe("active");
        expect(membership!.term).toBeNull();
      });
    }
  );
});

describe("grantLifetimeMembership — Stripe one-time path (real Postgres)", () => {
  maybeItTc(
    "a card lifetime upgrade cancels the seller's OTHER pending manual invoices, leaves historical/other-seller invoices untouched, and writes a never-expiring lifetime grant preserving the stripe_customer_id",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "card-lifetime-seller";
        const otherPubkey = "unrelated-card-seller";
        const customerId = "cus_wrangler_lifetime_1";

        const firstPendingInvoiceId = "herd-monthly-pending-card-1";
        const secondPendingInvoiceId = "herd-yearly-pending-card-1";
        const historicalPaidInvoiceId = "herd-yearly-paid-card-1";
        const historicalExpiredInvoiceId = "herd-monthly-expired-card-1";
        const otherSellerPendingInvoiceId = "other-seller-pending-card-1";

        // The seller already has an active Stripe subscription membership with a
        // saved customer id. The card lifetime upgrade reuses that customer, so
        // grantLifetimeMembership must preserve it while clearing the
        // subscription + lapse timeline.
        await pro.applyProStripeState({
          pubkey,
          customerId,
          subscriptionId: "sub_existing_1",
          baseStatus: "active",
          term: "monthly",
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          graceUntil: new Date(Date.now() + 37 * 24 * 60 * 60 * 1000),
          readonlyUntil: new Date(Date.now() + 44 * 24 * 60 * 60 * 1000),
          cancelAtPeriodEnd: false,
        });

        // Two still-open (pending) manual invoices for the SAME seller — these
        // are the stale Herd invoices that must be canceled so neither can later
        // stack a paid term on top of the never-expiring grant.
        await pro.createProManualInvoice({
          invoiceId: firstPendingInvoiceId,
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        await pro.createProManualInvoice({
          invoiceId: secondPendingInvoiceId,
          pubkey,
          term: "yearly",
          method: "fiat",
          amountUsdCents: 15000,
          amountSats: null,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // A historical PAID invoice for the same seller — must be left alone.
        await pro.createProManualInvoice({
          invoiceId: historicalPaidInvoiceId,
          pubkey,
          term: "yearly",
          method: "bitcoin",
          amountUsdCents: 15000,
          amountSats: 210000,
          dueAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });

        // A historical EXPIRED invoice for the same seller — must be left alone.
        await pro.createProManualInvoice({
          invoiceId: historicalExpiredInvoiceId,
          pubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });

        // A pending invoice belonging to a DIFFERENT seller — the cancel is
        // scoped by pubkey, so this must remain pending.
        await pro.createProManualInvoice({
          invoiceId: otherSellerPendingInvoiceId,
          pubkey: otherPubkey,
          term: "monthly",
          method: "bitcoin",
          amountUsdCents: 1500,
          amountSats: 21000,
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // Move the two historical invoices into their settled/expired states.
        const pool = db.getDbPool();
        await pool.query(
          `UPDATE pro_manual_invoices
              SET status = 'paid',
                  paid_at = now(),
                  membership_applied_at = now()
            WHERE invoice_id = $1`,
          [historicalPaidInvoiceId]
        );
        await pool.query(
          `UPDATE pro_manual_invoices SET status = 'expired' WHERE invoice_id = $1`,
          [historicalExpiredInvoiceId]
        );

        // The Stripe one-time lifetime webhook path.
        await pro.grantLifetimeMembership({
          pubkey,
          billingMethod: "stripe",
          customerId,
        });

        // Both pending invoices for this seller are canceled, and since they
        // were never settled no membership was applied to them.
        const firstPending = await pro.getProManualInvoice(
          firstPendingInvoiceId
        );
        expect(firstPending!.status).toBe("canceled");
        expect(firstPending!.membership_applied_at).toBeNull();

        const secondPending = await pro.getProManualInvoice(
          secondPendingInvoiceId
        );
        expect(secondPending!.status).toBe("canceled");
        expect(secondPending!.membership_applied_at).toBeNull();

        // Historical paid invoice is untouched.
        const historicalPaid = await pro.getProManualInvoice(
          historicalPaidInvoiceId
        );
        expect(historicalPaid!.status).toBe("paid");

        // Historical expired invoice is untouched.
        const historicalExpired = await pro.getProManualInvoice(
          historicalExpiredInvoiceId
        );
        expect(historicalExpired!.status).toBe("expired");

        // The unrelated seller's pending invoice is untouched.
        const otherSellerPending = await pro.getProManualInvoice(
          otherSellerPendingInvoiceId
        );
        expect(otherSellerPending!.status).toBe("pending");

        // Membership row: never-expiring lifetime grant. billing_method flips to
        // stripe, the subscription + lapse timeline are cleared, and the
        // existing stripe_customer_id is preserved.
        const membership = await pro.getProMembership(pubkey);
        expect(membership).not.toBeNull();
        expect(membership!.lifetime).toBe(true);
        expect(membership!.status).toBe("active");
        expect(membership!.billing_method).toBe("stripe");
        expect(membership!.term).toBeNull();
        expect(membership!.stripe_customer_id).toBe(customerId);
        expect(membership!.stripe_subscription_id).toBeNull();
        expect(membership!.current_period_end).toBeNull();
        expect(membership!.grace_until).toBeNull();
        expect(membership!.readonly_until).toBeNull();
        expect(membership!.cancel_at_period_end).toBe(false);
      });
    }
  );

  maybeItTc(
    "preserves a prior membership's stripe_customer_id when the grant is called without one",
    async () => {
      await withProMembershipDb(async ({ db, pro }) => {
        await waitForTables(db, ["pro_memberships", "pro_manual_invoices"]);

        const pubkey = "card-lifetime-no-customer";
        const existingCustomerId = "cus_preexisting_2";

        // Seed a prior Stripe membership carrying a customer id.
        await pro.applyProStripeState({
          pubkey,
          customerId: existingCustomerId,
          subscriptionId: "sub_existing_2",
          baseStatus: "active",
          term: "yearly",
          currentPeriodEnd: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          graceUntil: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000),
          readonlyUntil: new Date(Date.now() + 74 * 24 * 60 * 60 * 1000),
          cancelAtPeriodEnd: false,
        });

        // Grant lifetime WITHOUT passing a customer id — COALESCE must keep the
        // existing one rather than nulling it out.
        await pro.grantLifetimeMembership({
          pubkey,
          billingMethod: "stripe",
        });

        const membership = await pro.getProMembership(pubkey);
        expect(membership!.lifetime).toBe(true);
        expect(membership!.status).toBe("active");
        expect(membership!.term).toBeNull();
        expect(membership!.stripe_customer_id).toBe(existingCustomerId);
        expect(membership!.stripe_subscription_id).toBeNull();
        expect(membership!.current_period_end).toBeNull();
      });
    }
  );
});
