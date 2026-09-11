/**
 * @jest-environment node
 *
 * Regression coverage for the fresh self-host install boot deadlock (#350):
 *
 * - withSchemaDdlLock wraps every schema-DDL batch in one explicit
 *   BEGIN/COMMIT transaction holding a pg_advisory_xact_lock so two boot-time
 *   DDL batches (initializeTables vs lazy ensure*Table helpers, possibly in
 *   another process) can't take AccessExclusiveLock on the same relations in
 *   different orders and deadlock (Postgres 40P01). Transaction-scoped (not
 *   session-scoped) locking is what makes this safe through transaction
 *   poolers like Neon's -pooler endpoint, where consecutive queries on one
 *   pooled client may land on different backend sessions.
 * - getDbPool()'s automatic schema bootstrap is single-flight: concurrent
 *   triggers share one initializeTables() run.
 * - A failed bootstrap is logged and retried on the next trigger — it must
 *   never surface as an unhandledRejection (which crashes the process under
 *   --unhandled-rejections=strict).
 */

import { withSchemaDdlLock } from "@/utils/db/db-service";

type MockClient = {
  queries: string[];
  query: jest.Mock;
  release: jest.Mock;
};

// Shared with the pg mock factory below (jest hoisting requires the "mock"
// prefix for out-of-scope references).
const mockState = {
  clients: [] as MockClient[],
  // Per-query override hook; return a promise to replace the default
  // resolved { rows: [] } response, or undefined for the default.
  onQuery: null as null | ((sql: string) => Promise<any> | undefined),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    connect: jest.fn(async () => {
      const client: MockClient = {
        queries: [],
        query: jest.fn(async (text: any, _params?: any[]) => {
          const sql = typeof text === "string" ? text : (text?.text ?? "");
          client.queries.push(sql);
          const override = mockState.onQuery?.(sql);
          if (override) return override;
          return { rows: [], rowCount: 0 };
        }),
        release: jest.fn(),
      };
      mockState.clients.push(client);
      return client;
    }),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    on: jest.fn(),
    end: jest.fn(async () => {}),
  })),
}));

const flush = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const INIT_MARKER = "CREATE TABLE IF NOT EXISTS product_events";
const initMarkerCount = () =>
  mockState.clients
    .flatMap((c) => c.queries)
    .filter((q) => q.includes(INIT_MARKER)).length;

describe("withSchemaDdlLock", () => {
  it("holds the xact lock for the whole DDL batch inside one transaction", async () => {
    const client = { query: jest.fn(async (_text: string) => ({ rows: [] })) };
    let ran = false;

    await withSchemaDdlLock(client as any, async () => {
      ran = true;
      // The transaction (and its lock) must still be open while the DDL runs.
      expect(
        client.query.mock.calls.some(([q]) => String(q) === "COMMIT")
      ).toBe(false);
    });

    const calls = client.query.mock.calls.map(([q]) => String(q));
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toContain("pg_advisory_xact_lock");
    expect(calls[calls.length - 1]).toBe("COMMIT");
    expect(ran).toBe(true);
  });

  it("rolls back (releasing the lock) when the DDL throws", async () => {
    const client = { query: jest.fn(async (_text: string) => ({ rows: [] })) };

    await expect(
      withSchemaDdlLock(client as any, async () => {
        throw new Error("deadlock detected");
      })
    ).rejects.toThrow("deadlock detected");

    const calls = client.query.mock.calls.map(([q]) => String(q));
    expect(calls[calls.length - 1]).toBe("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("does not open a nested transaction when the client already holds the lock", async () => {
    const client = { query: jest.fn(async (_text: string) => ({ rows: [] })) };

    await withSchemaDdlLock(client as any, async (locked) => {
      // Nested call on the same client (the ensure* helpers invoked mid-way
      // through initializeTables) runs inline — the outer transaction
      // already holds the xact lock.
      await withSchemaDdlLock(locked as any, async () => "inner");
    });

    const calls = client.query.mock.calls.map(([q]) => String(q));
    expect(calls.filter((q) => q === "BEGIN")).toHaveLength(1);
    expect(calls.filter((q) => q === "COMMIT")).toHaveLength(1);
    expect(calls.filter((q) => q.includes("pg_advisory_xact_lock"))).toHaveLength(
      1
    );
  });
});

describe("schema bootstrap single-flight", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
    };
    mockState.clients = [];
    mockState.onQuery = null;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("runs initializeTables once across concurrent triggers", async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    try {
      // Hold the advisory-lock query so the first bootstrap stays in flight
      // while a second trigger fires.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockState.onQuery = (sql) =>
        sql.includes("pg_advisory_lock")
          ? gate.then(() => ({ rows: [] }))
          : undefined;

      await jest.isolateModulesAsync(async () => {
        const db = await import("@/utils/db/db-service");
        db.getDbPool();
        db.getDbPool();
        release();
        await flush();
      });

      expect(initMarkerCount()).toBe(1);
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("does not publish initialized state when the schema COMMIT fails", async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let failCommit = true;
    mockState.onQuery = (sql) =>
      failCommit && sql === "COMMIT"
        ? Promise.reject(new Error("commit failed"))
        : undefined;

    try {
      await jest.isolateModulesAsync(async () => {
        const db = await import("@/utils/db/db-service");
        db.getDbPool();
        await flush();

        // The commit failed, so the run must have rolled back, been logged,
        // and NOT marked the schema initialized — the next trigger retries.
        expect(errorSpy).toHaveBeenCalledWith(
          "Failed to initialize database tables:",
          expect.any(Error)
        );
        failCommit = false;
        await db.cacheEvent({
          id: "e1",
          pubkey: "p1",
          created_at: 1,
          kind: 30402,
          tags: [],
          content: "",
          sig: "s1",
        });
        await flush();
      });

      expect(initMarkerCount()).toBe(2);
      const rollbacks = mockState.clients
        .flatMap((c) => c.queries)
        .filter((q) => q === "ROLLBACK");
      expect(rollbacks.length).toBeGreaterThanOrEqual(1);
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      errorSpy.mockRestore();
    }
  });

  it("logs a failed bootstrap (never unhandled) and retries on the next trigger", async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    mockState.onQuery = (sql) =>
      fail && sql.includes(INIT_MARKER)
        ? Promise.reject(new Error("deadlock detected"))
        : undefined;

    try {
      await jest.isolateModulesAsync(async () => {
        const db = await import("@/utils/db/db-service");
        db.getDbPool();
        await flush();

        expect(errorSpy).toHaveBeenCalledWith(
          "Failed to initialize database tables:",
          expect.any(Error)
        );

        // The failed run clears the stored promise, so the next accessor
        // awaiting ensureTablesInitialized() retries the bootstrap from
        // scratch. (getDbPool() only auto-bootstraps when creating the pool.)
        fail = false;
        await db.cacheEvent({
          id: "e1",
          pubkey: "p1",
          created_at: 1,
          kind: 30402,
          tags: [],
          content: "",
          sig: "s1",
        });
        await flush();
      });

      expect(initMarkerCount()).toBe(2);
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      errorSpy.mockRestore();
    }
  });
});
