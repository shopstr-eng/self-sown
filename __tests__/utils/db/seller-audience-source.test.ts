/**
 * @jest-environment node
 *
 * DB-level lock-in for getSellerAudienceEmails(pubkey, source?) source
 * narrowing: a source-targeted send ("popup" / "subscription") must return
 * ONLY popup_email_captures of that origin — buyers come from orders and
 * carry no capture origin, so the buyers union must NOT leak in. With no
 * source the audience is buyers UNION all captures (unchanged behavior).
 * Unsubscribes filter every variant.
 *
 * Exercises the REAL function and its actual SQL against pg-mem (same
 * harness as popup-capture-source.test.ts): real writers for captures and
 * unsubscribes; buyer rows seeded as raw inserts (the read query's JOIN is
 * the contract, and saveNotificationEmail's partial-index ON CONFLICT is
 * beyond pg-mem).
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (seller_pubkey, email)
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  const AUDIENCE_TABLES =
    /popup_email_captures|notification_emails|message_events|email_unsubscribes/i;

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Capture writers use RETURNING (xmax = 0) AS is_new, which pg-mem
        // can't evaluate — rewrite to a literal from a pre-INSERT probe
        // (params[0]=seller_pubkey, params[1]=email for both writers).
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
        // Skip the runtime production-schema bootstrap — pg-mem can't parse
        // all of it, and this test creates the only tables it exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!AUDIENCE_TABLES.test(sql)) {
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
  getSellerAudienceEmails,
  savePopupEmailCapture,
  saveSubscriberEmailCapture,
  unsubscribeSellerEmail,
} from "@/utils/db/db-service";

const SELLER = "a".repeat(64);
const OTHER = "c".repeat(64);

// A buyer = a notification_emails buyer row joined to one of the seller's
// order DMs (message_events). The INNER JOIN is what ties a buyer to THIS
// seller — a buyer row without a matching message_event is not audience.
async function seedBuyer(orderId: string, email: string, sellerPubkey: string) {
  // Template literals: pg-mem's direct none() doesn't bind $n params (the
  // adapter client.query path does). All values are test constants.
  await memDb.public.none(
    `INSERT INTO notification_emails (pubkey, email, role, order_id)
     VALUES ('${sellerPubkey}', '${email}', 'buyer', '${orderId}');`
  );
  await memDb.public.none(
    `INSERT INTO message_events (id, pubkey, created_at, kind, order_id)
     VALUES ('msg_${orderId}', '${sellerPubkey}', 1, 1059, '${orderId}');`
  );
}

async function seedAudience() {
  // One buyer of THIS seller, one buyer of ANOTHER seller, one popup
  // capture, one subscription capture.
  await seedBuyer("order_1", "buyer@example.com", SELLER);
  await seedBuyer("order_2", "other-buyer@example.com", OTHER);
  await savePopupEmailCapture(
    SELLER,
    "popup@example.com",
    null,
    "WELCOME10",
    10
  );
  await saveSubscriberEmailCapture(SELLER, "sub@example.com", null);
}

describe("getSellerAudienceEmails source narrowing (real SQL via pg-mem)", () => {
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
    await memDb.public.none(`DELETE FROM popup_email_captures;`);
    await memDb.public.none(`DELETE FROM notification_emails;`);
    await memDb.public.none(`DELETE FROM message_events;`);
    await memDb.public.none(`DELETE FROM email_unsubscribes;`);
  });

  it("source='popup' returns ONLY popup-origin captures — no buyers, no subscription captures", async () => {
    await seedAudience();
    const emails = await getSellerAudienceEmails(SELLER, "popup");
    expect(emails).toEqual(["popup@example.com"]);
  });

  it("source='subscription' returns ONLY subscription-origin captures", async () => {
    await seedAudience();
    const emails = await getSellerAudienceEmails(SELLER, "subscription");
    expect(emails).toEqual(["sub@example.com"]);
  });

  it("no source returns buyers UNION all captures (original behavior unchanged)", async () => {
    await seedAudience();
    const emails = await getSellerAudienceEmails(SELLER);
    expect(emails.sort()).toEqual([
      "buyer@example.com",
      "popup@example.com",
      "sub@example.com",
    ]);
    // The OTHER seller's buyer must never leak in any variant.
    expect(emails).not.toContain("other-buyer@example.com");
  });

  it("an unsubscribed capture is excluded from its source-targeted send", async () => {
    await seedAudience();
    await unsubscribeSellerEmail(SELLER, "popup@example.com");
    expect(await getSellerAudienceEmails(SELLER, "popup")).toEqual([]);
    // ...but the subscription segment is unaffected.
    expect(await getSellerAudienceEmails(SELLER, "subscription")).toEqual([
      "sub@example.com",
    ]);
  });

  it("an unsubscribed buyer is excluded from the full-audience send", async () => {
    await seedAudience();
    await unsubscribeSellerEmail(SELLER, "buyer@example.com");
    const emails = await getSellerAudienceEmails(SELLER);
    expect(emails.sort()).toEqual(["popup@example.com", "sub@example.com"]);
  });

  it("never leaks ANOTHER seller's captures into scoped or unscoped sends", async () => {
    await seedAudience();
    // The other seller has their own popup + subscription captures. Dropping
    // p.seller_pubkey = $1 from either query must fail this test.
    await savePopupEmailCapture(
      OTHER,
      "other-popup@example.com",
      null,
      "X5",
      5
    );
    await saveSubscriberEmailCapture(OTHER, "other-sub@example.com", null);

    expect(await getSellerAudienceEmails(SELLER, "popup")).toEqual([
      "popup@example.com",
    ]);
    expect(await getSellerAudienceEmails(SELLER, "subscription")).toEqual([
      "sub@example.com",
    ]);
    const full = await getSellerAudienceEmails(SELLER);
    expect(full).not.toContain("other-popup@example.com");
    expect(full).not.toContain("other-sub@example.com");
    expect(full).not.toContain("other-buyer@example.com");
    expect(full.sort()).toEqual([
      "buyer@example.com",
      "popup@example.com",
      "sub@example.com",
    ]);
  });

  it("the QUERY lower()s both sides: a raw mixed-case capture is suppressed by a raw UPPERCASE unsubscribe", async () => {
    // Raw inserts bypass the writers' lowercase-on-write normalization — this
    // pins the lower() calls in the audience SQL itself, not writer hygiene.
    await memDb.public.none(
      `INSERT INTO popup_email_captures
         (seller_pubkey, email, phone, discount_code, discount_percentage, source)
       VALUES ('${SELLER}', 'MixedCase@Example.com', NULL, 'WELCOME10', 10, 'popup');`
    );
    await memDb.public.none(
      `INSERT INTO email_unsubscribes (seller_pubkey, email)
       VALUES ('${SELLER}', 'MIXEDCASE@EXAMPLE.COM');`
    );
    const emails = await getSellerAudienceEmails(SELLER, "popup");
    expect(emails).not.toContain("mixedcase@example.com");
    expect(emails).toEqual([]);
  });
});
