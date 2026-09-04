/**
 * @jest-environment node
 *
 * Real-SQL coverage (pg-mem) for scheduled-post failure recording (#127): when
 * the publishing cron releases a claimed row with a failure, the stored row
 * must gain attempt_count + 1, last_error (truncated), and last_attempt_at —
 * the fields the settings UI's "Retrying"/"Failed" badge consumes. Also pins
 * the matched-on-event_id guard (a seller re-save is never clobbered by a
 * stale cron tick) and the success-path cleanup. Harness pattern from
 * blog-broadcast-segments.test.ts.
 */

import type { IMemoryDb } from "pg-mem";

jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE scheduled_blog_posts (
      id SERIAL PRIMARY KEY,
      pubkey TEXT NOT NULL,
      d_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      event_id TEXT NOT NULL,
      signed_event JSONB NOT NULL,
      scheduled_at BIGINT,
      send_as_email BOOLEAN NOT NULL DEFAULT FALSE,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT,
      processing_at BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at BIGINT,
      UNIQUE (pubkey, d_tag)
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
        if (!/scheduled_blog_posts/i.test(sql)) {
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

// db-service lazily builds its pool from DATABASE_URL, so a syntactically
// valid URL must be present even though pg-mem never uses it.
process.env.DATABASE_URL =
  "postgresql://user:pass@ep-test-instance.us-east-2.aws.neon.tech/neondb";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const memDb: IMemoryDb = (require("pg") as any).__memDb;

import {
  releaseScheduledBlogPostClaim,
  deletePublishedScheduledBlogPost,
} from "@/utils/db/db-service";

const SELLER = "a".repeat(64);

// Template-literal seed: direct memDb none() doesn't bind $n params, and all
// values here are test constants.
function seedRow(eventId = "evt-1", processingAt: number | null = 1700000000) {
  const processing = processingAt === null ? "NULL" : String(processingAt);
  return memDb.public.none(`
    INSERT INTO scheduled_blog_posts
      (pubkey, d_tag, status, event_id, signed_event, scheduled_at,
       send_as_email, title, processing_at)
    VALUES ('${SELLER}', 'post-1', 'scheduled', '${eventId}', '{}',
            1700000000, true, 'Hello', ${processing});
  `);
}

async function readRow(): Promise<any> {
  // pg-mem's query helpers return synchronously here (none() returns
  // undefined, many() returns the array) — await handles either shape.
  const result: any = memDb.public.many(
    `SELECT * FROM scheduled_blog_posts WHERE pubkey = '${SELLER}';`
  );
  const rows = typeof result?.then === "function" ? await result : result;
  return rows[0];
}

describe("scheduled_blog_posts failure recording (real SQL via pg-mem)", () => {
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
    await memDb.public.none(`DELETE FROM scheduled_blog_posts;`);
  });

  it("a failed publish attempt increments attempt_count, stores last_error, stamps last_attempt_at", async () => {
    await seedRow();

    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-1", {
      error: "Publishing failed: relay down",
      at: 1700001000,
    });

    let row = await readRow();
    expect(Number(row.attempt_count)).toBe(1);
    expect(row.last_error).toBe("Publishing failed: relay down");
    expect(Number(row.last_attempt_at)).toBe(1700001000);
    // The cron lock is cleared so the next tick retries.
    expect(row.processing_at).toBeNull();

    // A second failed attempt stacks the counter and refreshes the fields.
    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-1", {
      error: "Post published, but emailing it failed; will retry.",
      at: 1700002000,
    });
    row = await readRow();
    expect(Number(row.attempt_count)).toBe(2);
    expect(row.last_error).toBe(
      "Post published, but emailing it failed; will retry."
    );
    expect(Number(row.last_attempt_at)).toBe(1700002000);
  });

  it("truncates a pathological error string to 500 chars", async () => {
    await seedRow();
    const huge = "x".repeat(5000);
    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-1", {
      error: huge,
      at: 1700001000,
    });
    const row = await readRow();
    expect(row.last_error.length).toBe(500);
  });

  it("a failure-free release clears the lock WITHOUT touching retry counters", async () => {
    await seedRow();
    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-1", {
      error: "first failure",
      at: 1700001000,
    });
    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-1");

    const row = await readRow();
    expect(row.processing_at).toBeNull();
    expect(Number(row.attempt_count)).toBe(1);
    expect(row.last_error).toBe("first failure");
    expect(Number(row.last_attempt_at)).toBe(1700001000);
  });

  it("a stale cron tick's release never clobbers a re-saved (new event_id) row", async () => {
    await seedRow("evt-new");

    // The cron is still holding the OLD event's claim; the seller has since
    // re-saved (which resets the counters under the new event_id).
    await releaseScheduledBlogPostClaim(SELLER, "post-1", "evt-old", {
      error: "Publishing failed: stale tick",
      at: 1700001000,
    });

    const row = await readRow();
    expect(Number(row.attempt_count)).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.last_attempt_at).toBeNull();
    expect(row.processing_at).toBe(1700000000); // lock untouched too
  });

  it("a successful publish deletes the row — and only for the matching event_id", async () => {
    await seedRow("evt-1");

    // A stale tick trying to clean up a DIFFERENT version must not delete.
    await deletePublishedScheduledBlogPost(SELLER, "post-1", "evt-old");
    expect(await readRow()).toBeTruthy();

    // The tick that actually published the stored version cleans up.
    await deletePublishedScheduledBlogPost(SELLER, "post-1", "evt-1");
    expect(await readRow()).toBeUndefined();
  });
});
