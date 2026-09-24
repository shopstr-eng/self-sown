/**
 * @jest-environment node
 */

// End-to-end, real-database proof of the one-time broadcast RETRY contract
// (utils/email/one-time-broadcast.ts). The sibling suite
// utils/db/__tests__/one-time-broadcast-claim-db.test.ts proves the claim and
// per-recipient ledger PRIMITIVES against real Postgres, and
// __tests__/utils/email/one-time-broadcast.test.ts proves the orchestration
// against sequential mocks — but a mock cannot prove that runOneTimeBroadcast
// wired those primitives together correctly. Here ONLY the SendGrid boundary
// (sendEmailStrictFromDetailed / sendEmail) is mocked; the audience query,
// sender-domain resolution, branding lookup, claim, and recipient ledger all
// hit real tables:
//
//   1. Partial provider outage mid-blast: some recipients succeed, one fails
//      AMBIGUOUSLY (timeout/5xx — SendGrid may have accepted it), one fails
//      DEFINITELY (4xx — provably not accepted). A retry with the same
//      idempotency key must NOT re-email the delivered or ambiguous
//      recipients and MUST deliver the definite-reject (released) one. A
//      third run reports already-sent and sends nothing.
//   2. All-failed blast (provider down): the fresh claim is RELEASED in the
//      real one_time_broadcast_claims table so the retry is not blocked by
//      the daily cap — while the content-keyed recipient ledger (claims
//      retained, failure was ambiguous) makes the retry already-sent with
//      zero new sends and zero new claim rows.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   ONE_TIME_BROADCAST_TEST_DATABASE_URL=postgres://...
//                                   — runs against an existing Postgres
//                                     (e.g. the dev database; falls back to
//                                     BROADCAST_CLAIM_TEST_DATABASE_URL so the
//                                     claim suite's setup also unlocks this
//                                     one). All test rows are namespaced
//                                     behind one fixed synthetic seller pubkey
//                                     and deleted in afterEach/afterAll.

jest.setTimeout(300000);

// Module marker: keeps the type aliases below out of the global script scope.
export {};

type DbServiceModule = typeof import("@/utils/db/db-service");
type BroadcastModule = typeof import("@/utils/email/one-time-broadcast");

// THE ONLY MOCK: the SendGrid boundary. Per-recipient outcomes are keyed by
// the `to` address so the concurrent send workers (SEND_CONCURRENCY) can't
// make the simulated failure pattern order-dependent.
const mockSendDetailed: jest.Mock = jest.fn();
const mockSendEmail: jest.Mock = jest.fn(async () => true);
jest.mock("@/utils/email/email-service", () => {
  const actual = jest.requireActual("@/utils/email/email-service");
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    sendEmailStrictFromDetailed: (...args: unknown[]) =>
      mockSendDetailed(...args),
  };
});

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL =
  process.env.ONE_TIME_BROADCAST_TEST_DATABASE_URL ||
  process.env.BROADCAST_CLAIM_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeIt = SHOULD_RUN ? test : test.skip;

// Fixed synthetic seller pubkey (distinct from the claim suite's "a"*64 so
// the two suites never share rows): deterministic so an interrupted previous
// run's rows are swept by the cleanup in beforeAll/afterEach/afterAll.
const SELLER_PK = "c".repeat(64);
const SENDER_DOMAIN = "bcast-e2e.invalid";
const SENDER_EMAIL = `orders@${SENDER_DOMAIN}`;

// Namespaced audience addresses: each test's cleanup deletes by seller
// pubkey, so these can never collide with real contacts.
const DELIVERED_1 = "bcast-e2e-delivered-1@example.com";
const DELIVERED_2 = "bcast-e2e-delivered-2@example.com";
const AMBIGUOUS = "bcast-e2e-ambiguous@example.com";
const REJECTED = "bcast-e2e-rejected@example.com";

let db: DbServiceModule;
let runOneTimeBroadcast: BroadcastModule["runOneTimeBroadcast"];
let stopDatabase: (() => Promise<void>) | null = null;
let previousDatabaseUrl: string | undefined;
let previousUnsubscribeSecret: string | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;

  let databaseUrl: string;
  if (RUN_CONTAINERS) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:15-alpine")
      .withDatabase("shopstr")
      .withUsername("shopstr")
      .withPassword("shopstr")
      .start();
    stopDatabase = async () => {
      await container.stop();
    };
    databaseUrl = `postgres://shopstr:shopstr@${container.getHost()}:${container.getMappedPort(
      5432
    )}/shopstr`;
  } else {
    databaseUrl = EXTERNAL_DATABASE_URL!;
  }

  // DATABASE_URL must stay set for the whole suite: getDbPool reads it
  // lazily on first use (and email-sender-domains binds a pool at module
  // scope). Restored in afterAll.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  // The broadcast fails closed ("unsubscribe-unavailable") without the token
  // secret. It is present in the dev environment; synthesize one for CI
  // testcontainers so the gate is exercised, not bypassed.
  previousUnsubscribeSecret = process.env.AFFILIATE_UNSUBSCRIBE_SECRET;
  if (
    !process.env.AFFILIATE_UNSUBSCRIBE_SECRET ||
    process.env.AFFILIATE_UNSUBSCRIBE_SECRET.length < 16
  ) {
    process.env.AFFILIATE_UNSUBSCRIBE_SECRET =
      "bcast-e2e-synthetic-unsubscribe-secret";
  }

  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("@/utils/db/db-service");
    ({ runOneTimeBroadcast } = await import("@/utils/email/one-time-broadcast"));
  });

  await waitForTables([
    "one_time_broadcast_claims",
    "one_time_broadcast_recipients",
    "popup_email_captures",
    "email_sender_domains",
    "email_unsubscribes",
    "profile_events",
  ]);
  await cleanupTestRows();
}, 300000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  try {
    await cleanupTestRows();
    await db.closeDbPool();
  } finally {
    if (stopDatabase) await stopDatabase();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousUnsubscribeSecret === undefined) {
      delete process.env.AFFILIATE_UNSUBSCRIBE_SECRET;
    } else {
      process.env.AFFILIATE_UNSUBSCRIBE_SECRET = previousUnsubscribeSecret;
    }
  }
}, 120000);

beforeEach(async () => {
  mockSendDetailed.mockReset();
  mockSendEmail.mockClear();
  // afterEach cleanup deletes the sender row too, so re-seed it per test.
  if (SHOULD_RUN) await seedSenderDomain();
});

afterEach(async () => {
  if (!SHOULD_RUN) return;
  await cleanupTestRows();
});

async function waitForTables(tableNames: string[]): Promise<void> {
  const deadline = Date.now() + 60000;
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
      if (result.rows.length === tableNames.length) return;
    } finally {
      client.release();
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
}

/** Deletes every row the synthetic seller could have touched. */
async function cleanupTestRows(): Promise<void> {
  const pool = db.getDbPool();
  await pool.query(`DELETE FROM one_time_broadcast_claims WHERE pubkey = $1`, [
    SELLER_PK,
  ]);
  await pool.query(
    `DELETE FROM one_time_broadcast_recipients WHERE pubkey = $1`,
    [SELLER_PK]
  );
  await pool.query(
    `DELETE FROM popup_email_captures WHERE seller_pubkey = $1`,
    [SELLER_PK]
  );
  await pool.query(`DELETE FROM email_unsubscribes WHERE seller_pubkey = $1`, [
    SELLER_PK,
  ]);
  await pool.query(`DELETE FROM email_sender_domains WHERE pubkey = $1`, [
    SELLER_PK,
  ]);
}

/** The fail-closed sender gate, satisfied with a REAL validated domain row. */
async function seedSenderDomain(): Promise<void> {
  await db.getDbPool().query(
    `INSERT INTO email_sender_domains (pubkey, domain, valid, from_email)
     VALUES ($1, $2, TRUE, $3)
     ON CONFLICT (pubkey) DO UPDATE SET
       domain = EXCLUDED.domain,
       valid = TRUE,
       from_email = EXCLUDED.from_email`,
    [SELLER_PK, SENDER_DOMAIN, SENDER_EMAIL]
  );
}

/** Audience via popup captures — the same SQL union the broadcast reads. */
async function seedAudience(emails: string[]): Promise<void> {
  const pool = db.getDbPool();
  for (const email of emails) {
    await pool.query(
      `INSERT INTO popup_email_captures
         (seller_pubkey, email, discount_code, discount_percentage, source)
       VALUES ($1, $2, 'E2E', 0, 'popup')
       ON CONFLICT (seller_pubkey, email) DO NOTHING`,
      [SELLER_PK, email]
    );
  }
}

async function countClaims(): Promise<number> {
  const result = await db.getDbPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM one_time_broadcast_claims
     WHERE pubkey = $1`,
    [SELLER_PK]
  );
  return Number(result.rows[0]?.n || 0);
}

/** Content-keyed recipient ledger rows for the synthetic seller. */
async function ledgerEmails(): Promise<string[]> {
  const result = await db.getDbPool().query<{ email: string }>(
    `SELECT email FROM one_time_broadcast_recipients WHERE pubkey = $1`,
    [SELLER_PK]
  );
  return result.rows.map((r) => r.email).sort();
}

function sentTo(): string[] {
  return mockSendDetailed.mock.calls.map((c) => c[0].to).sort();
}

maybeIt(
  "partial outage: a retry resends ONLY the definite-reject, never the delivered or ambiguous",
  async () => {
    await seedAudience([DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED]);

    const params = {
      pubkey: SELLER_PK,
      subject: "Harvest update",
      bodyHtml: "<p>This week's boxes are packed.</p>",
      idempotencyKey: "e2e-partial",
    };

    // Mid-blast partial SendGrid outage: two deliveries succeed, one times
    // out (ambiguous — SendGrid may have accepted it), one is refused with a
    // definite 4xx (provably never accepted).
    mockSendDetailed.mockImplementation(async ({ to }: { to: string }) => {
      if (to === AMBIGUOUS) return { ok: false, definiteReject: false };
      if (to === REJECTED) return { ok: false, definiteReject: true };
      return { ok: true, definiteReject: false };
    });

    const first = await runOneTimeBroadcast(params);
    expect(first).toEqual({ kind: "sent", sent: 2, failed: 2, total: 4 });
    expect(sentTo()).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED].sort()
    );
    // Every send went out from the seller's own verified domain address.
    for (const call of mockSendDetailed.mock.calls) {
      expect(call[0].fromEmail).toBe(SENDER_EMAIL);
    }

    // First attempt kept its claim (partial success is not all-failed) and
    // released ONLY the definite-reject recipient claim.
    expect(await countClaims()).toBe(1);
    expect(await ledgerEmails()).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS].sort()
    );

    // RETRY with the same idempotency key, provider healthy again. The claim
    // row still exists (claim === "exists" — retained, not re-claimed), and
    // the content-keyed ledger must suppress the delivered AND ambiguous
    // recipients: only the released definite-reject gets the email.
    mockSendDetailed.mockClear();
    mockSendDetailed.mockResolvedValue({ ok: true, definiteReject: false });

    const retry = await runOneTimeBroadcast(params);
    expect(retry).toEqual({ kind: "sent", sent: 1, failed: 0, total: 1 });
    expect(sentTo()).toEqual([REJECTED]);

    // Still exactly one claim row (the retry rode the retained claim), and
    // the ledger now covers the whole audience — including the ambiguous
    // recipient, who was never re-emailed.
    expect(await countClaims()).toBe(1);
    expect(await ledgerEmails()).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED].sort()
    );

    // A further retry finds the ledger covering the entire audience:
    // already-sent, no claim consumed, zero sends.
    mockSendDetailed.mockClear();
    const third = await runOneTimeBroadcast(params);
    expect(third).toEqual({ kind: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    expect(await countClaims()).toBe(1);
  }
);

maybeIt(
  "all-failed blast releases the claim in the real table, and the retry sends nothing without burning the daily cap",
  async () => {
    await seedAudience([DELIVERED_1, DELIVERED_2]);

    const params = {
      pubkey: SELLER_PK,
      subject: "Farm stand closed today",
      bodyHtml: "<p>Storm damage — back tomorrow.</p>",
      idempotencyKey: "e2e-outage",
    };

    // Provider fully down: every send fails ambiguously.
    mockSendDetailed.mockResolvedValue({ ok: false, definiteReject: false });

    const first = await runOneTimeBroadcast(params);
    expect(first).toEqual({ kind: "all-failed", sent: 0, failed: 2, total: 2 });
    expect(sentTo()).toEqual([DELIVERED_1, DELIVERED_2].sort());

    // The fresh claim was RELEASED — the real claims table holds no row for
    // this broadcast, so the daily cap budget is intact for the retry...
    expect(await countClaims()).toBe(0);
    // ...while both recipient claims were RETAINED (ambiguous failures:
    // SendGrid may have accepted the messages, so at-most-once wins).
    expect(await ledgerEmails()).toEqual([DELIVERED_1, DELIVERED_2].sort());

    // RETRY with the provider healthy: the pre-claim ledger read covers the
    // whole audience, so the outcome is already-sent BEFORE any claim is
    // taken — no sends, and still zero claim rows (cap never burned).
    mockSendDetailed.mockClear();
    mockSendDetailed.mockResolvedValue({ ok: true, definiteReject: false });

    const retry = await runOneTimeBroadcast(params);
    expect(retry).toEqual({ kind: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    expect(await countClaims()).toBe(0);
  }
);
