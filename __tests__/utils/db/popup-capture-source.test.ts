/**
 * @jest-environment node
 *
 * Source-column conflict semantics for the popup/subscription contact list.
 *
 * `popup_email_captures` stores a `source` column ('popup' vs 'subscription')
 * recording where a contact came from. The two writers have DELIBERATELY
 * different conflict behavior, and a regression here would silently mislabel a
 * seller's contact origins:
 *
 *   - `savePopupEmailCapture`     -> sets source='popup' on INSERT *and* resets
 *                                    it to 'popup' on conflict (a subscriber who
 *                                    later claims a welcome offer becomes 'popup').
 *   - `saveSubscriberEmailCapture`-> sets source='subscription' only on INSERT,
 *                                    and does NOT touch source on conflict (a
 *                                    popup contact who later subscribes KEEPS
 *                                    'popup').
 *
 * We exercise the REAL functions against an in-memory Postgres (pg-mem) so the
 * actual `ON CONFLICT` SQL is executed, not a copy. pg-mem doesn't implement the
 * `xmax` system column, so the wrapped client rewrites the function's
 * `RETURNING (xmax = 0) AS is_new` into a literal computed from a pre-INSERT
 * existence probe (params[0]=seller_pubkey, params[1]=email for both writers).
 */

import { newDb, type IMemoryDb } from "pg-mem";

// One shared in-memory DB instance, created in the `pg` mock factory so the
// lazily-constructed pool in db-service talks to the same store we seed/inspect.
jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb();
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
  // getPopupEmailCapturesBySeller LEFT JOINs discount_codes for usage counts.
  memDb.public.none(`
    CREATE TABLE discount_codes (
      code TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      times_used INTEGER NOT NULL DEFAULT 0
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        if (/xmax = 0/.test(sql) && params) {
          const existing = await raw.query(
            `SELECT 1 FROM popup_email_captures WHERE seller_pubkey = $1 AND email = $2`,
            [params[0], params[1]]
          );
          const wasNew = existing.rows.length === 0;
          const rewritten = sql.replace(
            /\(xmax = 0\) AS is_new/,
            `${wasNew} AS is_new`
          );
          return raw.query(rewritten, params);
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
      // db-service registers a pool 'error' handler; no-op for pg-mem.
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

// db-service lazily builds its pool from DATABASE_URL (and rewrites the host to
// a pooler endpoint), so a syntactically valid URL must be present.
process.env.DATABASE_URL =
  "postgresql://user:pass@ep-test-instance.us-east-2.aws.neon.tech/neondb";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const memDb: IMemoryDb = (require("pg") as any).__memDb;

import {
  savePopupEmailCapture,
  saveSubscriberEmailCapture,
  getPopupEmailCapturesBySeller,
} from "@/utils/db/db-service";

const SELLER = "a".repeat(64);

async function sourceOf(email: string): Promise<string | undefined> {
  const rows = await getPopupEmailCapturesBySeller(SELLER);
  return rows.find((r) => r.email === email.toLowerCase())?.source;
}

describe("popup_email_captures source-column conflict semantics", () => {
  let errorSpy: jest.SpyInstance;
  beforeAll(() => {
    // db-service's lazy `initializeTables` runs the full production schema on
    // first pool use; pg-mem can't parse all of it and logs a (caught) error.
    // That's expected and irrelevant here — keep the test output clean.
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    errorSpy.mockRestore();
  });

  beforeEach(() => {
    // Tables are created once in the `pg` mock factory (pg-mem doesn't free a
    // PRIMARY KEY index name on DROP, so re-creating per test fails). Just clear
    // the rows between tests.
    memDb.public.none(`DELETE FROM popup_email_captures;`);
    memDb.public.none(`DELETE FROM discount_codes;`);
  });

  it("a new popup signup is stored with source 'popup'", async () => {
    const result = await savePopupEmailCapture(
      SELLER,
      "Popup@Example.com",
      null,
      "WELCOME10",
      10
    );
    expect(result.isNew).toBe(true);
    expect(await sourceOf("popup@example.com")).toBe("popup");
  });

  it("a new subscription signup is stored with source 'subscription'", async () => {
    const result = await saveSubscriberEmailCapture(
      SELLER,
      "Sub@Example.com",
      null
    );
    expect(result.isNew).toBe(true);
    expect(await sourceOf("sub@example.com")).toBe("subscription");
  });

  it("subscription-then-popup: claiming a welcome offer flips source to 'popup'", async () => {
    const first = await saveSubscriberEmailCapture(
      SELLER,
      "flip@example.com",
      null
    );
    expect(first.isNew).toBe(true);
    expect(await sourceOf("flip@example.com")).toBe("subscription");

    const second = await savePopupEmailCapture(
      SELLER,
      "flip@example.com",
      null,
      "WELCOME10",
      10
    );
    expect(second.isNew).toBe(false);
    expect(await sourceOf("flip@example.com")).toBe("popup");
  });

  it("popup-then-subscription: a later subscribe KEEPS the original 'popup' source", async () => {
    const first = await savePopupEmailCapture(
      SELLER,
      "keep@example.com",
      null,
      "WELCOME10",
      10
    );
    expect(first.isNew).toBe(true);
    expect(await sourceOf("keep@example.com")).toBe("popup");

    const second = await saveSubscriberEmailCapture(
      SELLER,
      "keep@example.com",
      null
    );
    expect(second.isNew).toBe(false);
    // Subscriber upsert does not touch `source` on conflict -> stays 'popup'.
    expect(await sourceOf("keep@example.com")).toBe("popup");
  });

  it("popup conflict preserves the discount code/percentage of the latest popup", async () => {
    await savePopupEmailCapture(SELLER, "code@example.com", null, "FIRST5", 5);
    await savePopupEmailCapture(
      SELLER,
      "code@example.com",
      null,
      "SECOND20",
      20
    );
    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "code@example.com");
    expect(row?.source).toBe("popup");
    expect(row?.discount_code).toBe("SECOND20");
  });

  it("subscriber conflict does NOT wipe an existing welcome-offer discount code", async () => {
    await savePopupEmailCapture(
      SELLER,
      "both@example.com",
      null,
      "WELCOME10",
      10
    );
    await saveSubscriberEmailCapture(SELLER, "both@example.com", null);
    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "both@example.com");
    // source stays 'popup' AND the discount code is untouched by the subscribe.
    expect(row?.source).toBe("popup");
    expect(row?.discount_code).toBe("WELCOME10");
  });
});

describe("getPopupEmailCapturesBySeller usage-count LEFT JOIN", () => {
  let errorSpy: jest.SpyInstance;
  beforeAll(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    errorSpy.mockRestore();
  });

  beforeEach(() => {
    memDb.public.none(`DELETE FROM popup_email_captures;`);
    memDb.public.none(`DELETE FROM discount_codes;`);
  });

  it("reports the matching discount code's times_used for a contact", async () => {
    await savePopupEmailCapture(
      SELLER,
      "buyer@example.com",
      null,
      "WELCOME10",
      10
    );
    memDb.public.none(
      `INSERT INTO discount_codes (code, pubkey, times_used)
         VALUES ('WELCOME10', '${SELLER}', 7);`
    );

    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "buyer@example.com");
    expect(row?.times_used).toBe(7);
  });

  it("returns times_used 0 (LEFT JOIN) when the contact's code has no discount_codes row", async () => {
    // Popup contact has a code, but that code was deleted from discount_codes.
    await savePopupEmailCapture(SELLER, "orphan@example.com", null, "GONE5", 5);

    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "orphan@example.com");
    // LEFT JOIN keeps the contact; COALESCE makes the missing count 0.
    expect(row).toBeDefined();
    expect(row?.times_used).toBe(0);
  });

  it("returns times_used 0 for a subscriber with an empty discount code", async () => {
    await saveSubscriberEmailCapture(SELLER, "sub@example.com", null);

    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "sub@example.com");
    expect(row).toBeDefined();
    expect(row?.source).toBe("subscription");
    expect(row?.times_used).toBe(0);
  });

  it("scopes a code's usage count to the owning seller (no cross-seller leak)", async () => {
    const OTHER = "b".repeat(64);
    // Both sellers happen to use the same code string, but each discount_codes
    // row is keyed by pubkey, so the join must not bleed counts across sellers.
    await savePopupEmailCapture(SELLER, "mine@example.com", null, "SHARED", 10);
    memDb.public.none(
      `INSERT INTO discount_codes (code, pubkey, times_used)
         VALUES ('SHARED', '${SELLER}', 3),
                ('SHARED', '${OTHER}', 99);`
    );

    const rows = await getPopupEmailCapturesBySeller(SELLER);
    const row = rows.find((r) => r.email === "mine@example.com");
    expect(row?.times_used).toBe(3);
  });

  it("returns rows newest-first and scoped to the requested seller", async () => {
    const OTHER = "b".repeat(64);
    // Seed three of the seller's contacts with explicit, out-of-order created_at
    // timestamps plus one belonging to a different seller that must not appear.
    memDb.public.none(`
      INSERT INTO popup_email_captures
        (seller_pubkey, email, phone, discount_code, discount_percentage, source, created_at)
      VALUES
        ('${SELLER}', 'oldest@example.com', NULL, '', 0, 'subscription', '2026-01-01T00:00:00Z'),
        ('${SELLER}', 'newest@example.com', NULL, '', 0, 'subscription', '2026-03-01T00:00:00Z'),
        ('${SELLER}', 'middle@example.com', NULL, '', 0, 'subscription', '2026-02-01T00:00:00Z'),
        ('${OTHER}',  'other@example.com',  NULL, '', 0, 'subscription', '2026-04-01T00:00:00Z');
    `);

    const rows = await getPopupEmailCapturesBySeller(SELLER);
    expect(rows.map((r) => r.email)).toEqual([
      "newest@example.com",
      "middle@example.com",
      "oldest@example.com",
    ]);
  });
});

describe("popup_email_captures source backfill (schema.sql migration)", () => {
  // The schema ships the backfill inside a plpgsql `DO $popup_source_migrate$`
  // block, which pg-mem doesn't implement. We exercise the block's effective
  // statements (the ones that run when the `source` column is first added):
  // ADD COLUMN ... DEFAULT 'popup', then flip empty-discount rows to
  // 'subscription'. Rows with a discount code keep the 'popup' default.
  it("flips empty-discount rows to 'subscription' and leaves coded rows as 'popup'", () => {
    const db = newDb();
    db.public.none(`
      CREATE TABLE popup_email_captures (
        id SERIAL PRIMARY KEY,
        seller_pubkey TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        discount_code TEXT NOT NULL,
        discount_percentage NUMERIC NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(seller_pubkey, email)
      );
    `);
    // Pre-migration rows: one welcome-offer (has a code) and one subscription
    // (empty code) captured before the `source` column existed.
    db.public.none(`
      INSERT INTO popup_email_captures
        (seller_pubkey, email, phone, discount_code, discount_percentage)
      VALUES
        ('s', 'hadcode@example.com', NULL, 'WELCOME10', 10),
        ('s', 'nocode@example.com', NULL, '', 0);
    `);

    // Effective statements of the DO block when the column is first added.
    db.public.none(
      `ALTER TABLE popup_email_captures ADD COLUMN source TEXT NOT NULL DEFAULT 'popup';`
    );
    db.public.none(
      `UPDATE popup_email_captures SET source = 'subscription' WHERE COALESCE(discount_code, '') = '';`
    );

    const rows = db.public.many(
      `SELECT email, source FROM popup_email_captures ORDER BY email`
    ) as Array<{ email: string; source: string }>;
    const bySource = Object.fromEntries(rows.map((r) => [r.email, r.source]));

    expect(bySource["hadcode@example.com"]).toBe("popup");
    expect(bySource["nocode@example.com"]).toBe("subscription");
  });
});
