/**
 * @jest-environment node
 *
 * Lock-in for the SendGrid suppression sync (the fix for re-emailing dead
 * addresses): an address SendGrid ACCEPTED at send time and then bounced
 * asynchronously lands on SendGrid's suppression lists minutes later. The
 * sync pulls those lists and must record the address as a per-seller
 * 'suppressed' unsubscribe so the NEXT broadcast audience (which filters
 * email_unsubscribes in SQL) excludes it.
 *
 * Exercises the REAL sync + REAL db accessors (suppressDeadAudienceEmails,
 * getSellerAudienceEmails, unsubscribeSellerEmail, pro_settings watermark)
 * against pg-mem (same harness as seller-audience-source.test.ts). Only the
 * SendGrid API boundary (api key + fetch) is mocked.
 */

import type { IMemoryDb } from "pg-mem";

// One shared in-memory DB instance, created in the `pg` mock factory so the
// lazily-constructed pool in db-service talks to the same store we seed.
jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE popup_email_captures (
      id SERIAL PRIMARY KEY,
      seller_pubkey TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      discount_code TEXT NOT NULL,
      discount_percentage NUMERIC NOT NULL,
      source TEXT NOT NULL DEFAULT 'popup',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(seller_pubkey, email)
    );
  `);
  memDb.public.none(`
    CREATE TABLE notification_emails (
      id SERIAL PRIMARY KEY,
      pubkey TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      order_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  memDb.public.none(`
    CREATE TABLE message_events (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      kind INTEGER NOT NULL,
      order_id TEXT DEFAULT NULL
    );
  `);
  memDb.public.none(`
    CREATE TABLE email_unsubscribes (
      seller_pubkey TEXT NOT NULL,
      email TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (seller_pubkey, email)
    );
  `);
  memDb.public.none(`
    CREATE TABLE sendgrid_suppressed_emails (
      email TEXT PRIMARY KEY,
      list TEXT NOT NULL,
      first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  memDb.public.none(`
    CREATE TABLE pro_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  const SYNC_TABLES =
    /popup_email_captures|notification_emails|message_events|email_unsubscribes|sendgrid_suppressed_emails|pro_settings/i;

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Skip the runtime production-schema bootstrap — pg-mem can't parse
        // all of it, and this test creates the only tables it exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!SYNC_TABLES.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        return raw.query(sql, params);
      },
    };
  }

  class WrappedPool {
    private inner: any;
    constructor(...args: any[]) {
      this.inner = new MemPool(...args);
    }
    on() {
      return this;
    }
    async connect() {
      const raw = await this.inner.connect();
      return wrapClient(raw);
    }
    async query(sql: string, params?: any[]) {
      const raw = await this.inner.connect();
      const client = wrapClient(raw);
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    }
    async end() {
      if (typeof this.inner.end === "function") await this.inner.end();
    }
  }

  return { __memDb: memDb, Pool: WrappedPool };
});

// The SendGrid boundary: never hit the network (or the connector) in tests.
jest.mock("@/utils/email/sendgrid-client", () => ({
  getSendGridApiKey: async () => "SG.test-key",
}));

const mockFetch: jest.Mock = jest.fn();
(global as any).fetch = mockFetch;

// db-service lazily builds its pool from DATABASE_URL, so a syntactically
// valid URL must be present even though pg-mem never uses it.
process.env.DATABASE_URL =
  "postgresql://user:pass@ep-test-instance.us-east-2.aws.neon.tech/neondb";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const memDb: IMemoryDb = (require("pg") as any).__memDb;

import {
  getSellerAudienceEmails,
  getSellerEmailUnsubscribeCounts,
  unsubscribeSellerEmail,
} from "@/utils/db/db-service";
import { syncSendGridSuppressions } from "@/utils/email/sendgrid-suppressions";

const SELLER = "a".repeat(64);
const OTHER = "c".repeat(64);

function sgPage(entries: Array<{ email: string; created: number }>) {
  return {
    ok: true,
    status: 200,
    json: async () => entries,
  } as any;
}

// Seed a buyer of a seller: a notification_emails buyer row joined to one of
// the seller's order DMs (the INNER JOIN is what ties a buyer to a seller).
// Template literals: pg-mem's direct none() doesn't bind $n params.
async function seedBuyer(orderId: string, email: string, sellerPubkey: string) {
  await memDb.public.none(
    `INSERT INTO notification_emails (pubkey, email, role, order_id)
     VALUES ('${sellerPubkey}', '${email}', 'buyer', '${orderId}');`
  );
  await memDb.public.none(
    `INSERT INTO message_events (id, pubkey, created_at, kind, order_id)
     VALUES ('msg_${orderId}', '${sellerPubkey}', 1, 1059, '${orderId}');`
  );
}

async function seedCapture(email: string, sellerPubkey: string) {
  await memDb.public.none(
    `INSERT INTO popup_email_captures (seller_pubkey, email, discount_code, discount_percentage, source)
     VALUES ('${sellerPubkey}', '${email}', 'WELCOME', 10, 'popup');`
  );
}

beforeEach(async () => {
  mockFetch.mockReset();
  await memDb.public.none(`
    DELETE FROM popup_email_captures;
    DELETE FROM notification_emails;
    DELETE FROM message_events;
    DELETE FROM email_unsubscribes;
    DELETE FROM sendgrid_suppressed_emails;
    DELETE FROM pro_settings;
  `);

  // Seller's audience: one buyer, one popup capture, one spam-reporter
  // capture. An address in NOBODY's audience also exists nowhere — the sync
  // must ignore suppression entries that map to no seller.
  await seedBuyer("order_1", "bounced-buyer@example.com", SELLER);
  await seedCapture("live-contact@example.com", SELLER);
  await seedCapture("spam-reporter@example.com", SELLER);
  await seedBuyer("order_2", "other-buyer@example.com", OTHER);

  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/v3/suppression/bounces")) {
      return sgPage([
        { email: "bounced-buyer@example.com", created: 1700000100 },
        { email: "unknown@example.com", created: 1700000200 },
      ]);
    }
    if (url.includes("/v3/suppression/spam_reports")) {
      return sgPage([{ email: "spam-reporter@example.com", created: 1700000300 }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

describe("syncSendGridSuppressions", () => {
  it("excludes a SendGrid-bounced address from the next broadcast audience", async () => {
    const before = await getSellerAudienceEmails(SELLER);
    expect(before).toContain("bounced-buyer@example.com");
    expect(before).toContain("spam-reporter@example.com");

    const result = await syncSendGridSuppressions();
    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(3);

    const after = await getSellerAudienceEmails(SELLER);
    expect(after).not.toContain("bounced-buyer@example.com");
    expect(after).not.toContain("spam-reporter@example.com");
    // Reachable contacts are untouched.
    expect(after).toContain("live-contact@example.com");

    const counts = await getSellerEmailUnsubscribeCounts(SELLER);
    expect(counts).toEqual({ unsubscribed: 0, suppressed: 2 });
  });

  it("records suppressions per seller: an address is only suppressed for sellers whose audience contains it", async () => {
    await syncSendGridSuppressions();
    // OTHER's audience never contained the bounced/spam addresses, so they
    // must NOT be suppressed for OTHER.
    const otherAudience = await getSellerAudienceEmails(OTHER);
    expect(otherAudience).toContain("other-buyer@example.com");
    const otherCounts = await getSellerEmailUnsubscribeCounts(OTHER);
    expect(otherCounts).toEqual({ unsubscribed: 0, suppressed: 0 });

    // The suppression entry for an address nobody emails is a no-op.
    const unknownCheck = await memDb.public.many(
      `SELECT * FROM email_unsubscribes WHERE email = 'unknown@example.com'`
    );
    expect(unknownCheck).toHaveLength(0);
  });

  it("never rewrites a deliberate 'user' opt-out to 'suppressed'", async () => {
    await unsubscribeSellerEmail(SELLER, "bounced-buyer@example.com", "user");
    const result = await syncSendGridSuppressions();
    expect(result.ok).toBe(true);
    const counts = await getSellerEmailUnsubscribeCounts(SELLER);
    // bounced-buyer keeps its original 'user' reason; only the spam reporter
    // is newly recorded as suppressed.
    expect(counts).toEqual({ unsubscribed: 1, suppressed: 1 });
  });

  it("advances the watermark and only pulls newer entries on the next run", async () => {
    await syncSendGridSuppressions();
    const firstRunUrls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(firstRunUrls.every((u) => !u.includes("start_time"))).toBe(true);

    mockFetch.mockClear();
    const second = await syncSendGridSuppressions();
    expect(second.ok).toBe(true);
    const secondRunUrls = mockFetch.mock.calls.map((c) => c[0] as string);
    // Per-list watermarks = the newest created timestamp seen per list.
    expect(
      secondRunUrls.find((u) => u.includes("/v3/suppression/bounces"))
    ).toContain("start_time=1700000200");
    expect(
      secondRunUrls.find((u) => u.includes("/v3/suppression/spam_reports"))
    ).toContain("start_time=1700000300");
  });

  it("excludes a previously-suppressed address from a seller who captures it AFTER the sync", async () => {
    // Sync runs and drains: bounced-buyer@example.com is recorded while it
    // belongs only to SELLER's audience, then the watermark advances past it.
    const first = await syncSendGridSuppressions();
    expect(first.ok).toBe(true);

    // A NEW seller captures the same dead address later. No per-seller
    // unsubscribe row can exist for them (the sync already moved on), but
    // the account-global suppression cache must still exclude the address
    // from their audience.
    const NEW_SELLER = "b".repeat(64);
    await seedCapture("bounced-buyer@example.com", NEW_SELLER);
    await seedCapture("fresh@example.com", NEW_SELLER);

    const audience = await getSellerAudienceEmails(NEW_SELLER);
    expect(audience).not.toContain("bounced-buyer@example.com");
    expect(audience).toContain("fresh@example.com");
    const counts = await getSellerEmailUnsubscribeCounts(NEW_SELLER);
    expect(counts).toEqual({ unsubscribed: 0, suppressed: 0 });
  });

  it("resumes past a capped page window instead of re-fetching the same newest pages", async () => {
    // Three bounces, newest first. pageLimit=2 + maxPages=1 forces each run
    // to process exactly one page and hit the cap.
    const bounces = [
      { email: "b300@example.com", created: 1700000300 },
      { email: "b200@example.com", created: 1700000200 },
      { email: "b100@example.com", created: 1700000100 },
    ];
    mockFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const start = Number(u.searchParams.get("start_time") || "0");
      const end = u.searchParams.get("end_time");
      const endN = end === null ? Number.POSITIVE_INFINITY : Number(end);
      if (u.pathname.includes("/v3/suppression/bounces")) {
        const offset = Number(u.searchParams.get("offset") || "0");
        const limit = Number(u.searchParams.get("limit") || "500");
        const filtered = bounces.filter(
          (e) => e.created >= start && e.created <= endN
        );
        return sgPage(filtered.slice(offset, offset + limit));
      }
      if (u.pathname.includes("/v3/suppression/spam_reports")) {
        return sgPage([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // Run 1: processes the two NEWEST entries, hits the cap, and must NOT
    // advance the watermark (the window is not fully synced).
    const run1 = await syncSendGridSuppressions({ pageLimit: 2, maxPagesPerList: 1 });
    expect(run1.ok).toBe(true);

    mockFetch.mockClear();
    const run2 = await syncSendGridSuppressions({ pageLimit: 2, maxPagesPerList: 1 });
    expect(run2.ok).toBe(true);
    // Run 2 must walk BACKWARD (end_time at the oldest processed entry),
    // not re-pull the same newest window.
    const run2BounceUrls = mockFetch.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes("/v3/suppression/bounces"));
    expect(run2BounceUrls).toHaveLength(1);
    expect(run2BounceUrls[0]).toContain("end_time=1700000200");

    // Run 3 drains the remainder (end_time=1700000100 → single entry < limit).
    mockFetch.mockClear();
    const run3 = await syncSendGridSuppressions({ pageLimit: 2, maxPagesPerList: 1 });
    expect(run3.ok).toBe(true);

    // Every entry across all three runs is recorded.
    for (const e of bounces) {
      const rows = await memDb.public.many(
        `SELECT * FROM sendgrid_suppressed_emails WHERE email = '${e.email}'`
      );
      expect(rows).toHaveLength(1);
    }

    // Once drained, the watermark advances to the newest entry: the next run
    // pulls only newer suppressions, with no end_time resume cursor.
    mockFetch.mockClear();
    await syncSendGridSuppressions({ pageLimit: 2, maxPagesPerList: 1 });
    const run4BounceUrls = mockFetch.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes("/v3/suppression/bounces"));
    expect(run4BounceUrls[0]).toContain("start_time=1700000300");
    expect(run4BounceUrls[0]).not.toContain("end_time");
  });

  it("still processes spam reports when the bounces list hits the page cap", async () => {
    const bounces = Array.from({ length: 4 }, (_, i) => ({
      email: `cap${i}@example.com`,
      created: 1700000100 + i,
    }));
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/v3/suppression/bounces")) return sgPage(bounces);
      if (url.includes("/v3/suppression/spam_reports")) {
        return sgPage([{ email: "spam-reporter@example.com", created: 1700000300 }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await syncSendGridSuppressions({ pageLimit: 2, maxPagesPerList: 1 });
    expect(result.ok).toBe(true);
    // A capped bounces list must not starve spam_reports.
    expect(await getSellerAudienceEmails(SELLER)).not.toContain(
      "spam-reporter@example.com"
    );
  });

  it("fails closed without advancing the watermark when SendGrid errors", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const result = await syncSendGridSuppressions();
    expect(result.ok).toBe(false);
    // Nothing recorded, nothing skipped: a retry re-pulls the full window.
    const audience = await getSellerAudienceEmails(SELLER);
    expect(audience).toContain("bounced-buyer@example.com");

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/v3/suppression/bounces")) {
        return sgPage([{ email: "bounced-buyer@example.com", created: 1700000100 }]);
      }
      return sgPage([]);
    });
    mockFetch.mockClear();
    await syncSendGridSuppressions();
    const retryUrls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(retryUrls.some((u) => !u.includes("start_time"))).toBe(true);
    expect(await getSellerAudienceEmails(SELLER)).not.toContain(
      "bounced-buyer@example.com"
    );
  });
});
