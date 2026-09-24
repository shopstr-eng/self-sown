/**
 * @jest-environment node
 */

// End-to-end, real-database proof of the blog-post broadcast RETRY contract
// (utils/email/blog-broadcast.ts). The sibling suite
// utils/email/__tests__/one-time-broadcast-db.test.ts proves the same contract
// for the one-time (agent-triggered) broadcast, and
// __tests__/utils/email/blog-broadcast-segment.test.ts proves this
// orchestration against sequential mocks — but a mock cannot prove that
// runBlogBroadcast wired the real ledgers together correctly. Here ONLY the
// SendGrid boundary (sendEmailStrictFrom) is mocked; the post lookup, audience
// query, sender-domain resolution, segment claims, and per-recipient ledger
// all hit real tables:
//
//   1. Partial provider outage mid-blast: some recipients succeed, one fails
//      AMBIGUOUSLY (timeout/5xx — SendGrid may have accepted it), one fails
//      DEFINITELY with a NON-recipient 4xx (sender/account-level — provably
//      not accepted, but the address is not at fault). A retry of the SAME
//      published version rides the retained segment claim
//      (blog_email_broadcasts) and resends ONLY the definite-reject — the
//      immutable per-recipient ledger (blog_email_broadcast_recipients)
//      suppresses the delivered AND the ambiguous recipients, so nobody is
//      ever emailed twice. A third run reports already-sent and sends
//      nothing.
//   2. All-failed blast (provider down, every failure ambiguous): the fresh
//      segment claim is RELEASED in the real blog_email_broadcasts table so
//      the retry is not blocked — while the retained recipient claims make
//      the retry already-sent with zero new sends and zero new claim rows.
//   3. Per-segment claim keys: a popup-only send and a full send of the same
//      version coexist as ('popup') and ('all') rows keyed by
//      (pubkey, d_tag, event_id, audience_source), and the full send never
//      re-emails the contact the popup send already delivered.
//   4. Recipient-level definite reject (SendGrid blames the address itself):
//      the address lands on the seller's real email_unsubscribes row, the
//      SAME version's retry never re-attempts it, and a broadcast of a NEW
//      version skips it in the audience SQL before any claim or send.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   BLOG_BROADCAST_TEST_DATABASE_URL=postgres://...
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
type BroadcastModule = typeof import("@/utils/email/blog-broadcast");

// THE ONLY MOCK: the SendGrid boundary. Per-recipient outcomes are keyed by
// the `to` address so the concurrent send workers (SEND_CONCURRENCY) can't
// make the simulated failure pattern order-dependent.
const mockSendDetailed: jest.Mock = jest.fn(async () => ({
  ok: true,
  definiteReject: false,
  recipientReject: false,
}));
jest.mock("@/utils/email/email-service", () => {
  const actual = jest.requireActual("@/utils/email/email-service");
  return {
    ...actual,
    sendEmailStrictFromDetailed: (...args: unknown[]) =>
      mockSendDetailed(...args),
  };
});

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL =
  process.env.BLOG_BROADCAST_TEST_DATABASE_URL ||
  process.env.BROADCAST_CLAIM_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeIt = SHOULD_RUN ? test : test.skip;

// Fixed synthetic seller pubkey (distinct from the claim suite's "a"*64 and
// the one-time broadcast suite's "c"*64 so the suites never share rows):
// deterministic so an interrupted previous run's rows are swept by the
// cleanup in beforeAll/afterEach/afterAll.
const SELLER_PK = "d".repeat(64);
const SENDER_DOMAIN = "blog-bcast-e2e.invalid";
const SENDER_EMAIL = `news@${SENDER_DOMAIN}`;

// One published post version per test (distinct event ids; the d-tag is
// shared — cleanup deletes every long_form_events row for the seller).
const D_TAG = "e2e-blog-post";
const EVENT_PARTIAL = "e2e-blog-event-partial";
const EVENT_OUTAGE = "e2e-blog-event-outage";
const EVENT_SEGMENTS = "e2e-blog-event-segments";
const EVENT_DEAD_1 = "e2e-blog-event-dead-1";
const EVENT_DEAD_2 = "e2e-blog-event-dead-2";

// Namespaced audience addresses: each test's cleanup deletes by seller
// pubkey, so these can never collide with real contacts.
const DELIVERED_1 = "blog-e2e-delivered-1@example.com";
const DELIVERED_2 = "blog-e2e-delivered-2@example.com";
const AMBIGUOUS = "blog-e2e-ambiguous@example.com";
const REJECTED = "blog-e2e-rejected@example.com";
const DEAD = "blog-e2e-dead@example.com";
const POPUP_ONLY = "blog-e2e-popup@example.com";
const SUBSCRIPTION_ONLY = "blog-e2e-subscription@example.com";

let db: DbServiceModule;
let runBlogBroadcast: BroadcastModule["runBlogBroadcast"];
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
      "blog-bcast-e2e-synthetic-unsubscribe-secret";
  }

  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("@/utils/db/db-service");
    ({ runBlogBroadcast } = await import("@/utils/email/blog-broadcast"));
  });

  await waitForTables([
    "long_form_events",
    "blog_email_broadcasts",
    "blog_email_broadcast_recipients",
    "popup_email_captures",
    "email_sender_domains",
    "email_unsubscribes",
    "shop_slugs",
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
  mockSendDetailed.mockResolvedValue({
    ok: true,
    definiteReject: false,
    recipientReject: false,
  });
  // afterEach cleanup deletes the sender + post rows too, so re-seed per test.
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
  await pool.query(`DELETE FROM blog_email_broadcasts WHERE pubkey = $1`, [
    SELLER_PK,
  ]);
  await pool.query(
    `DELETE FROM blog_email_broadcast_recipients WHERE pubkey = $1`,
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
  await pool.query(`DELETE FROM long_form_events WHERE pubkey = $1`, [
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

/**
 * Cache a signed kind:30023 post version the way the relay ingester would:
 * runBlogBroadcast re-fetches the post from long_form_events and refuses to
 * email anything whose cached id does not match the requested eventId.
 */
async function seedBlogPost(
  eventId: string,
  createdAt = 1000
): Promise<void> {
  await db.getDbPool().query(
    `INSERT INTO long_form_events (id, pubkey, created_at, kind, tags, content, sig)
     VALUES ($1, $2, ${createdAt}, 30023, $3::jsonb, 'Post body', 'e2e-sig')`,
    [
      eventId,
      SELLER_PK,
      JSON.stringify([
        ["d", D_TAG],
        ["title", "Harvest notes"],
        ["published_at", "900"],
      ]),
    ]
  );
}

/** Audience via popup captures — the same SQL union the broadcast reads. */
async function seedAudience(
  emails: string[],
  source: "popup" | "subscription" = "popup"
): Promise<void> {
  const pool = db.getDbPool();
  for (const email of emails) {
    await pool.query(
      `INSERT INTO popup_email_captures
         (seller_pubkey, email, discount_code, discount_percentage, source)
       VALUES ($1, $2, 'E2E', 0, $3)
       ON CONFLICT (seller_pubkey, email) DO NOTHING`,
      [SELLER_PK, email, source]
    );
  }
}

/** Real segment claim rows: (d_tag, event_id, audience_source) tuples. */
async function claimRows(): Promise<
  Array<{ d_tag: string; event_id: string; audience_source: string }>
> {
  const result = await db.getDbPool().query<{
    d_tag: string;
    event_id: string;
    audience_source: string;
  }>(
    `SELECT d_tag, event_id, audience_source FROM blog_email_broadcasts
      WHERE pubkey = $1
      ORDER BY audience_source`,
    [SELLER_PK]
  );
  return result.rows;
}

/** Per-recipient ledger emails for one published version. */
async function ledgerEmails(eventId: string): Promise<string[]> {
  const result = await db.getDbPool().query<{ email: string }>(
    `SELECT email FROM blog_email_broadcast_recipients
      WHERE pubkey = $1 AND event_id = $2`,
    [SELLER_PK, eventId]
  );
  return result.rows.map((r) => r.email).sort();
}

function sentTo(): string[] {
  return mockSendDetailed.mock.calls.map((c) => c[0].to).sort();
}

maybeIt(
  "partial outage: a retry rides the retained claim and resends ONLY the definite-reject, never the delivered or ambiguous",
  async () => {
    await seedBlogPost(EVENT_PARTIAL);
    await seedAudience([DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED]);

    const params = {
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_PARTIAL,
    };

    // Mid-blast partial SendGrid outage: two deliveries succeed, one times
    // out (AMBIGUOUS — SendGrid may have accepted it), one is refused with a
    // definite NON-recipient 4xx (sender/account-level: provably never
    // accepted, but the address is not at fault, so no suppression and the
    // retry below must re-attempt it).
    mockSendDetailed.mockImplementation(async ({ to }: { to: string }) => {
      if (to === AMBIGUOUS)
        return { ok: false, definiteReject: false, recipientReject: false };
      if (to === REJECTED)
        return { ok: false, definiteReject: true, recipientReject: false };
      return { ok: true, definiteReject: false, recipientReject: false };
    });

    const first = await runBlogBroadcast(params);
    expect(first).toEqual({ kind: "sent", sent: 2, failed: 2, total: 4 });
    expect(sentTo()).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED].sort()
    );
    // Every send went out from the seller's own verified domain address.
    for (const call of mockSendDetailed.mock.calls) {
      expect(call[0].fromEmail).toBe(SENDER_EMAIL);
    }

    // First attempt kept its per-segment version claim (partial success is
    // not all-failed) keyed ('all'). The real recipient ledger covers the
    // delivered contacts AND the ambiguous one (claim retained — SendGrid may
    // have accepted it, so at-most-once wins); ONLY the definite-reject claim
    // was released for a retry.
    expect(await claimRows()).toEqual([
      { d_tag: D_TAG, event_id: EVENT_PARTIAL, audience_source: "all" },
    ]);
    expect(await ledgerEmails(EVENT_PARTIAL)).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS].sort()
    );

    // RETRY the same published version with the provider healthy again. The
    // version claim already exists — the retry must RIDE it (not skip) and
    // the ledger must suppress the delivered AND ambiguous recipients: only
    // the released definite-reject gets the email. (mockResolvedValue
    // REPLACES the failing mockImplementation above; mockClear alone would
    // leave it in place.)
    mockSendDetailed.mockClear();
    mockSendDetailed.mockResolvedValue({
      ok: true,
      definiteReject: false,
      recipientReject: false,
    });

    const retry = await runBlogBroadcast(params);
    expect(retry).toEqual({ kind: "sent", sent: 1, failed: 0, total: 1 });
    expect(sentTo()).toEqual([REJECTED]);

    // Still exactly one claim row (the retry rode the retained claim), and
    // the ledger now covers the whole audience — the delivered and ambiguous
    // contacts were never re-emailed.
    expect(await claimRows()).toEqual([
      { d_tag: D_TAG, event_id: EVENT_PARTIAL, audience_source: "all" },
    ]);
    expect(await ledgerEmails(EVENT_PARTIAL)).toEqual(
      [DELIVERED_1, DELIVERED_2, AMBIGUOUS, REJECTED].sort()
    );

    // A further retry finds the ledger covering the entire audience:
    // already-sent, no claim consumed, zero sends.
    mockSendDetailed.mockClear();
    const third = await runBlogBroadcast(params);
    expect(third).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    expect(await claimRows()).toHaveLength(1);
  }
);

maybeIt(
  "all-failed blast (ambiguous) releases the segment claim in the real table, and the retry sends nothing — at-most-once over the whole outage",
  async () => {
    await seedBlogPost(EVENT_OUTAGE);
    await seedAudience([DELIVERED_1, DELIVERED_2]);

    const params = {
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_OUTAGE,
    };

    // Provider fully down: every send fails AMBIGUOUSLY (timeout/5xx —
    // SendGrid may have accepted some of them).
    mockSendDetailed.mockResolvedValue({
      ok: false,
      definiteReject: false,
      recipientReject: false,
    });

    const first = await runBlogBroadcast(params);
    expect(first).toEqual({ kind: "all-failed", sent: 0, failed: 2, total: 2 });
    expect(sentTo()).toEqual([DELIVERED_1, DELIVERED_2].sort());

    // The fresh segment claim was RELEASED — the real blog_email_broadcasts
    // table holds no row for this version, so a retry is not blocked...
    expect(await claimRows()).toEqual([]);
    // ...while both recipient claims were RETAINED (ambiguous failures:
    // acceptance unknown, so at-most-once wins).
    expect(await ledgerEmails(EVENT_OUTAGE)).toEqual(
      [DELIVERED_1, DELIVERED_2].sort()
    );

    // RETRY with the provider healthy: the pre-claim ledger read covers the
    // whole audience, so the outcome is already-sent BEFORE any claim is
    // taken — no sends (nobody can be double-emailed), and still zero claim
    // rows.
    mockSendDetailed.mockClear();
    mockSendDetailed.mockResolvedValue({
      ok: true,
      definiteReject: false,
      recipientReject: false,
    });

    const retry = await runBlogBroadcast(params);
    expect(retry).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    expect(await claimRows()).toEqual([]);
  }
);

maybeIt(
  "recipient-level definite reject is durably suppressed: never re-attempted by the same version's retry NOR by a later version's broadcast",
  async () => {
    await seedBlogPost(EVENT_DEAD_1);
    await seedAudience([DELIVERED_1, DEAD]);

    // First broadcast of version 1: one delivery succeeds; the DEAD address
    // is refused with a recipient-attributable 4xx (invalid address / on
    // SendGrid's suppression list) — provably dead, so it must never be
    // re-attempted.
    mockSendDetailed.mockImplementation(async ({ to }: { to: string }) => {
      if (to === DEAD)
        return { ok: false, definiteReject: true, recipientReject: true };
      return { ok: true, definiteReject: false, recipientReject: false };
    });

    const first = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_DEAD_1,
    });
    expect(first).toEqual({ kind: "sent", sent: 1, failed: 1, total: 2 });
    expect(sentTo()).toEqual([DEAD, DELIVERED_1].sort());

    // The dead address landed on the seller's REAL suppression list...
    expect(await db.isSellerEmailUnsubscribed(SELLER_PK, DEAD)).toBe(true);
    expect(await db.isSellerEmailUnsubscribed(SELLER_PK, DELIVERED_1)).toBe(
      false
    );
    // ...recorded as a provider suppression, NOT a user opt-out, so the
    // seller can tell "undeliverable address" apart from "person opted out".
    expect(await db.getSellerEmailUnsubscribeCounts(SELLER_PK)).toEqual({
      unsubscribed: 0,
      suppressed: 1,
    });
    // ...and its released recipient claim was NOT replaced.
    expect(await ledgerEmails(EVENT_DEAD_1)).toEqual([DELIVERED_1]);

    // RETRY the SAME version with the provider healthy: the audience SQL
    // excludes the suppressed address and the ledger covers DELIVERED_1, so
    // there is nothing left to send — already-sent with zero sends. Before
    // the suppression, this retry re-attempted the dead address.
    mockSendDetailed.mockClear();
    mockSendDetailed.mockResolvedValue({
      ok: true,
      definiteReject: false,
      recipientReject: false,
    });

    const retry = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_DEAD_1,
    });
    expect(retry).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();

    // Broadcast a NEW version of the post: the suppression is keyed to the
    // SELLER (not the version), so the dead address is filtered out of the
    // fresh audience before any claim or send — only DELIVERED_1 is emailed.
    // Newer created_at so the d-tag lookup resolves THIS version, not the
    // first (fetchBlogPostByDTagAndPubkey orders by created_at DESC).
    await seedBlogPost(EVENT_DEAD_2, 2000);
    const nextVersion = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_DEAD_2,
    });
    expect(nextVersion).toEqual({ kind: "sent", sent: 1, failed: 0, total: 1 });
    expect(sentTo()).toEqual([DELIVERED_1]);
  }
);

maybeIt(
  "per-segment claims: a popup send then a full send of one version creates distinct segment keys and never double-emails",
  async () => {
    await seedBlogPost(EVENT_SEGMENTS);
    await seedAudience([POPUP_ONLY], "popup");
    await seedAudience([SUBSCRIPTION_ONLY], "subscription");

    // First a popup-only send of the version.
    const popup = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_SEGMENTS,
      audienceSource: "popup",
    });
    expect(popup).toEqual({ kind: "sent", sent: 1, failed: 0, total: 1 });
    expect(sentTo()).toEqual([POPUP_ONLY]);
    // The version claim is keyed to the POPUP segment only.
    expect(await claimRows()).toEqual([
      { d_tag: D_TAG, event_id: EVENT_SEGMENTS, audience_source: "popup" },
    ]);

    // Then the full-audience send of the SAME version: the popup contact is
    // already in the per-recipient ledger and must NOT be re-emailed — only
    // the subscription contact is new.
    mockSendDetailed.mockClear();
    const full = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_SEGMENTS,
    });
    expect(full).toEqual({ kind: "sent", sent: 1, failed: 0, total: 1 });
    expect(sentTo()).toEqual([SUBSCRIPTION_ONLY]);

    // Two distinct (d_tag, event_id, audience_source) claim rows now exist
    // for one published version, and the ledger covers each contact exactly
    // once across both sends.
    expect(await claimRows()).toEqual([
      { d_tag: D_TAG, event_id: EVENT_SEGMENTS, audience_source: "all" },
      { d_tag: D_TAG, event_id: EVENT_SEGMENTS, audience_source: "popup" },
    ]);
    expect(await ledgerEmails(EVENT_SEGMENTS)).toEqual(
      [POPUP_ONLY, SUBSCRIPTION_ONLY].sort()
    );

    // Re-running the popup segment finds its audience already delivered:
    // already-sent, no sends, no new claim rows.
    mockSendDetailed.mockClear();
    const again = await runBlogBroadcast({
      pubkey: SELLER_PK,
      dTag: D_TAG,
      eventId: EVENT_SEGMENTS,
      audienceSource: "popup",
    });
    expect(again).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    expect(await claimRows()).toHaveLength(2);
  }
);
