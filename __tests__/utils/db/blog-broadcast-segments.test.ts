/**
 * @jest-environment node
 *
 * Real-SQL coverage for the per-segment blog broadcast ledger (#154):
 * blog_email_broadcasts is keyed per (pubkey, d_tag, event_id,
 * audience_source), so one published version can be claimed once per audience
 * segment ('popup' / 'subscription' / 'all') while re-claiming the SAME
 * segment stays blocked. Exercises the real claim/release/segments functions
 * against pg-mem (harness pattern from popup-capture-source.test.ts).
 */

import type { IMemoryDb } from "pg-mem";

jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE blog_email_broadcasts (
      id SERIAL PRIMARY KEY,
      pubkey TEXT NOT NULL,
      d_tag TEXT NOT NULL,
      event_id TEXT NOT NULL,
      audience_source TEXT NOT NULL DEFAULT 'all',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pubkey, d_tag, event_id, audience_source)
    );
    CREATE TABLE blog_email_broadcast_recipients (
      pubkey TEXT NOT NULL,
      d_tag TEXT NOT NULL,
      event_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (pubkey, d_tag, event_id, email)
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Skip the runtime production-schema bootstrap; this test creates the
        // only table it exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!/blog_email_broadcast/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        // pg-mem enforces the uniques (no duplicate row is written) but
        // misreports a conflicting ON CONFLICT ... DO NOTHING insert as
        // rowCount 1 with a phantom RETURNING row. The claim functions key on
        // rowCount, so probe existence first and report the true outcome.
        if (
          /ON CONFLICT \(pubkey, d_tag, event_id, audience_source\) DO NOTHING/.test(
            sql
          ) &&
          params
        ) {
          const existing = await raw.query(
            `SELECT 1 FROM blog_email_broadcasts
              WHERE pubkey = $1 AND d_tag = $2 AND event_id = $3 AND audience_source = $4`,
            params
          );
          const wasNew = existing.rows.length === 0;
          const result = await raw.query(sql, params);
          return {
            ...result,
            rows: wasNew ? result.rows : [],
            rowCount: wasNew ? 1 : 0,
          };
        }
        if (
          /ON CONFLICT \(pubkey, d_tag, event_id, email\) DO NOTHING/.test(
            sql
          ) &&
          params
        ) {
          const existing = await raw.query(
            `SELECT 1 FROM blog_email_broadcast_recipients
              WHERE pubkey = $1 AND d_tag = $2 AND event_id = $3 AND email = $4`,
            params
          );
          const wasNew = existing.rows.length === 0;
          const result = await raw.query(sql, params);
          return {
            ...result,
            rows: wasNew ? result.rows : [],
            rowCount: wasNew ? 1 : 0,
          };
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

// db-service lazily builds its pool from DATABASE_URL, so a syntactically
// valid URL must be present even though pg-mem never uses it.
process.env.DATABASE_URL =
  "postgresql://user:pass@ep-test-instance.us-east-2.aws.neon.tech/neondb";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const memDb: IMemoryDb = (require("pg") as any).__memDb;

import {
  claimBlogBroadcast,
  releaseBlogBroadcast,
  getBlogBroadcastSegments,
  getBlogBroadcastRecipients,
  claimBlogBroadcastRecipient,
  releaseBlogBroadcastRecipient,
} from "@/utils/db/db-service";

const SELLER = "a".repeat(64);

describe("blog_email_broadcasts per-segment claim keys (real SQL via pg-mem)", () => {
  let errorSpy: jest.SpyInstance;
  beforeAll(() => {
    // The lazy initializeTables bootstrap logs a (caught) error on pg-mem —
    // expected and irrelevant; keep output clean.
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    errorSpy.mockRestore();
  });

  beforeEach(async () => {
    await memDb.public.none(`DELETE FROM blog_email_broadcasts;`);
  });

  it("the same version can be claimed once per segment (popup + subscription + all)", async () => {
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup")).toBe(
      true
    );
    expect(
      await claimBlogBroadcast(SELLER, "post-1", "evt-1", "subscription")
    ).toBe(true);
    // No source = the full-audience 'all' segment (pre-segment default).
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1")).toBe(true);

    const segments = await getBlogBroadcastSegments(SELLER, "post-1", "evt-1");
    expect(segments?.sort()).toEqual(["all", "popup", "subscription"]);
  });

  it("re-claiming the SAME segment for the same version is blocked", async () => {
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup")).toBe(
      true
    );
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup")).toBe(
      false
    );
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1")).toBe(true);
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1")).toBe(false);
  });

  it("a DIFFERENT published version (event id) gets fresh claims", async () => {
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup")).toBe(
      true
    );
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-2", "popup")).toBe(
      true
    );
  });

  it("releasing a segment claim frees ONLY that segment", async () => {
    await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup");
    await claimBlogBroadcast(SELLER, "post-1", "evt-1", "subscription");

    await releaseBlogBroadcast(SELLER, "post-1", "evt-1", "popup");

    // The popup claim can be retaken...
    expect(await claimBlogBroadcast(SELLER, "post-1", "evt-1", "popup")).toBe(
      true
    );
    // ...while the subscription claim survived the release.
    expect(
      await claimBlogBroadcast(SELLER, "post-1", "evt-1", "subscription")
    ).toBe(false);
  });
});

describe("blog_email_broadcast_recipients delivery ledger (real SQL via pg-mem)", () => {
  beforeEach(async () => {
    await memDb.public.none(`DELETE FROM blog_email_broadcast_recipients;`);
  });

  it("a recipient is claimable exactly once per version, across sends", async () => {
    expect(
      await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "x@example.com")
    ).toBe(true);
    expect(
      await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "x@example.com")
    ).toBe(false);
    // A different recipient — or a different published version — claims freely.
    expect(
      await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "y@example.com")
    ).toBe(true);
    expect(
      await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-2", "x@example.com")
    ).toBe(true);
  });

  it("releasing a failed delivery's claim makes the recipient re-claimable", async () => {
    await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "x@example.com");
    await releaseBlogBroadcastRecipient(
      SELLER,
      "post-1",
      "evt-1",
      "x@example.com"
    );
    expect(
      await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "x@example.com")
    ).toBe(true);
  });

  it("getBlogBroadcastRecipients lists the delivered set used for exclusion", async () => {
    await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "a@example.com");
    await claimBlogBroadcastRecipient(SELLER, "post-1", "evt-1", "b@example.com");
    const got = await getBlogBroadcastRecipients(SELLER, "post-1", "evt-1");
    expect(got?.sort()).toEqual(["a@example.com", "b@example.com"]);
  });
});
