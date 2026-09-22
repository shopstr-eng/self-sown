/**
 * @jest-environment node
 *
 * DB-level lock-in for getUnreadMessageCount(pubkey) recipient scoping:
 * NIP-17 gift-wrapped messages (kind 1059) carry an ephemeral outer pubkey,
 * so a message addressed to the seller is identified by its recipient p-tag.
 * The unread count must match the scoping fetchAllMessagesFromDb and
 * markMessagesAsRead use — otherwise the MCP session handshake always
 * reports 0 unread and sellers miss new inquiries.
 *
 * Exercises the REAL function and its actual SQL against pg-mem (same
 * harness as seller-audience-source.test.ts).
 */

import type { IMemoryDb } from "pg-mem";

// One shared in-memory DB instance, created in the `pg` mock factory so the
// lazily-constructed pool in db-service talks to the same store we seed.
jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE message_events (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      kind INTEGER NOT NULL,
      tags JSONB NOT NULL,
      content TEXT NOT NULL,
      sig TEXT NOT NULL,
      cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_read BOOLEAN DEFAULT FALSE,
      order_status TEXT DEFAULT NULL,
      order_id TEXT DEFAULT NULL
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Skip the runtime production-schema bootstrap — pg-mem can't parse
        // all of it, and this test creates the only table it exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!/message_events/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        // pg-mem has no jsonb_array_elements set-returning function, so
        // translate the recipient EXISTS clause into the equivalent @>
        // containment check (same "tags contain a ['p', pubkey] element"
        // predicate). Param order is preserved: $1 is still the pubkey.
        const rewritten = sql.replace(
          /EXISTS \(\s*SELECT 1\s*FROM jsonb_array_elements\(tags\) elem\s*WHERE elem->>0 = 'p' AND elem->>1 = \$(\d+)\s*\)/,
          (_match, n) => `tags @> ('[["p","' || $${n} || '"]]')::jsonb`
        );
        return raw.query(rewritten, params);
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

import { getUnreadMessageCount } from "@/utils/db/db-service";

const SELLER = "a".repeat(64);
const EPHEMERAL = "b".repeat(64);
const OTHER = "c".repeat(64);

async function seedMessage(
  id: string,
  outerPubkey: string,
  pTag: string | null,
  isRead: boolean | null
) {
  // Template literals: pg-mem's direct none() doesn't bind $n params (the
  // adapter client.query path does). All values are test constants.
  const tags = pTag === null ? "[]" : `[["p","${pTag}"]]`;
  const isReadSql = isRead === null ? "NULL" : String(isRead);
  await memDb.public.none(
    `INSERT INTO message_events (id, pubkey, created_at, kind, tags, content, sig, is_read)
     VALUES ('${id}', '${outerPubkey}', 1, 1059, '${tags}'::jsonb, 'enc', 'sig', ${isReadSql});`
  );
}

describe("getUnreadMessageCount recipient scoping (real SQL via pg-mem)", () => {
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
    await memDb.public.none(`DELETE FROM message_events;`);
  });

  it("counts a gift-wrapped message addressed to the seller via p-tag", async () => {
    // Outer pubkey is the ephemeral one-time key, NOT the seller's.
    await seedMessage("wrap_1", EPHEMERAL, SELLER, false);

    expect(await getUnreadMessageCount(SELLER)).toBe(1);
  });

  it("does not count messages p-tagged to someone else", async () => {
    await seedMessage("wrap_2", EPHEMERAL, OTHER, false);

    expect(await getUnreadMessageCount(SELLER)).toBe(0);
  });

  it("excludes read rows and counts NULL is_read as unread", async () => {
    await seedMessage("wrap_read", EPHEMERAL, SELLER, true);
    await seedMessage("wrap_null", EPHEMERAL, SELLER, null);

    expect(await getUnreadMessageCount(SELLER)).toBe(1);
  });

  it("still counts legacy rows whose outer pubkey is the seller's", async () => {
    await seedMessage("legacy_1", SELLER, null, false);

    expect(await getUnreadMessageCount(SELLER)).toBe(1);
  });
});
