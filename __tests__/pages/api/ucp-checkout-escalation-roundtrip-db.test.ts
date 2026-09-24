/**
 * @jest-environment node
 */

// Real-database round-trip test for persisted UCP escalation checkout
// sessions — the coverage the mocked-store suites (e.g.
// ucp-checkout-schema-parity.test.ts) CANNOT provide:
//
//   POST /api/ucp/checkout/sessions with a sats payment on a fiat-priced
//   product escalates (no live exchange rate in the charge path) and persists
//   a requires_escalation row carrying the engine's error + machine-readable
//   code. This suite drives the REAL route handlers, the REAL order engine,
//   and the REAL checkout-store SQL against a REAL Postgres, then proves the
//   saved session loads back through the REAL read endpoints:
//
//   1. GET /api/ucp/checkout/sessions/[id] returns the session with status
//      requires_escalation plus the error and code (a regression in the
//      INSERT — e.g. dropping the code column — fails here, not in prod).
//   2. GET /api/ucp/checkout/sessions (the key's list) contains the same
//      session with the same escalation fields.
//
// Everything on the request path runs for real: rate limiting (Postgres
// shared store), API-key auth against mcp_api_keys, Pro-entitlement gating
// (a trial row for the synthetic buyer), product lookup/parse from
// product_events, and the escalation persist. The escalation throw happens
// BEFORE any mint/Stripe network call (resolveSatsAmount fails closed), so
// no external seam needs stubbing.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   UCP_CHECKOUT_TEST_DATABASE_URL=postgres://...
//                                   — runs against an existing Postgres
//                                     (e.g. a CI service database or the dev
//                                     database). Test rows use synthetic
//                                     all-"e"/"f" pubkeys and a unique
//                                     TEST-NET-3 source IP, and are deleted
//                                     afterwards (exact ids + sweeps for
//                                     interrupted runs).

jest.setTimeout(300000);

// Module marker: keeps the type aliases below out of the global script
// scope (other real-DB suites declare similar names).
export {};

type DbServiceModule = typeof import("@/utils/db/db-service");
type AuthModule = typeof import("@/utils/mcp/auth");
type MembershipModule = typeof import("@/utils/pro/membership");
type CheckoutStoreModule = typeof import("@/utils/ucp/checkout-store");
type RateLimitModule = typeof import("@/utils/rate-limit");
type RouteHandler = (req: any, res: any) => Promise<any>;

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL = process.env.UCP_CHECKOUT_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeItTc = SHOULD_RUN ? test : test.skip;

const TABLES = [
  "product_events",
  "profile_events",
  "mcp_api_keys",
  "pro_memberships",
  "ucp_checkout_sessions",
  "rate_limit_counters",
];

// Synthetic markers — these pubkeys can never belong to real users, so
// cleanup sweeps by them are safe even after an interrupted run.
const BUYER_PK = "e".repeat(64);
const SELLER_PK = "f".repeat(64);
// Unique-per-run TEST-NET-3 source IP so rate-limit buckets never collide
// with real traffic or a concurrent run.
const SOURCE_IP = `203.0.113.${(Date.now() % 200) + 1}`;
// Unique-per-run bucket used only to force creation of the lazily-initialized
// rate_limit_counters table on a fresh database (see beforeAll).
const INIT_RATE_BUCKET = `zz-ucp-roundtrip-init-${Date.now()}`;
const PRODUCT_EVENT_ID = `zzucp${Date.now().toString(16)}${"0".repeat(64)}`.slice(
  0,
  64
);
const PRODUCT_D_TAG = `zz-ucp-roundtrip-${Date.now()}`;

let db: DbServiceModule;
let auth: AuthModule;
let membership: MembershipModule;
let checkoutStore: CheckoutStoreModule;
let rateLimit: RateLimitModule;
let sessionsHandler: RouteHandler;
let sessionByIdHandler: RouteHandler;
let stopDatabase: (() => Promise<void>) | null = null;
let previousDatabaseUrl: string | undefined;

let apiKeyPlaintext: string;
let apiKeyId: number;
let escalationSessionId: string;
let escalationBody: any;

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
  // lazily on first use. Restored in afterAll.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  // Load db-service AND the route handlers inside one isolated module
  // context so they share the same connection pool (the routes reach
  // getDbPool through checkout-store / mcp auth / the order engine).
  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("@/utils/db/db-service");
    auth = await import("@/utils/mcp/auth");
    membership = await import("@/utils/pro/membership");
    checkoutStore = await import("@/utils/ucp/checkout-store");
    rateLimit = await import("@/utils/rate-limit");
    sessionsHandler = (await import("@/pages/api/ucp/checkout/sessions"))
      .default;
    sessionByIdHandler = (
      await import("@/pages/api/ucp/checkout/sessions/[id]")
    ).default;
  });

  await auth.initializeApiKeysTable();
  await checkoutStore.initCheckoutSessionsTable();
  // rate_limit_counters is NOT part of the main schema bootstrap — it is
  // created lazily by the first shared-store call. Force that creation now,
  // or a fresh Testcontainers database times out in waitForTables below (and
  // cleanup would query a missing table).
  await rateLimit.checkRateLimit(`${INIT_RATE_BUCKET}`, "init", {
    limit: 1,
    windowMs: 1000,
  });
  await waitForTables(TABLES);

  // Clear any rows left behind by an interrupted previous run.
  await cleanupTestRows();

  // A real read_write API key whose owner passes the Pro gate.
  const { key, record } = await auth.createApiKey(
    "ucp-escalation-roundtrip",
    BUYER_PK,
    "read_write"
  );
  apiKeyPlaintext = key;
  apiKeyId = record.id;
  await membership.startNewUserProTrial(BUYER_PK, "monthly");

  // A real fiat-priced product listing: a sats payment on it escalates
  // because the charge path has no authoritative exchange rate.
  await db.getDbPool().query(
    `INSERT INTO product_events (id, pubkey, created_at, kind, tags, content, sig)
     VALUES ($1, $2, $3, 30402, $4::jsonb, $5, $6)`,
    [
      PRODUCT_EVENT_ID,
      SELLER_PK,
      Math.floor(Date.now() / 1000),
      JSON.stringify([
        ["d", PRODUCT_D_TAG],
        ["title", "UCP Escalation Roundtrip Product"],
        ["price", "30", "USD"],
      ]),
      "{}",
      "0".repeat(64),
    ]
  );

  // POST the escalation once; the read tests below share the saved session.
  const postRes = createResponse();
  await sessionsHandler(
    createRequest({
      method: "POST",
      body: { productId: PRODUCT_EVENT_ID, paymentMethod: "lightning" },
    }),
    postRes
  );
  expect(postRes.statusCode).toBe(200);
  escalationBody = postRes.body;
  escalationSessionId = postRes.body.id;
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
  }
}, 120000);

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

/** Deletes every row this suite (or an interrupted run) could have written. */
async function cleanupTestRows(): Promise<void> {
  const pool = db.getDbPool();
  // Order matters: sessions reference mcp_api_keys(id).
  await pool.query(
    `DELETE FROM ucp_checkout_sessions WHERE buyer_pubkey = $1 OR seller_pubkey = $2`,
    [BUYER_PK, SELLER_PK]
  );
  await pool.query(`DELETE FROM mcp_api_keys WHERE pubkey = $1`, [BUYER_PK]);
  await pool.query(`DELETE FROM pro_memberships WHERE pubkey = $1`, [
    BUYER_PK,
  ]);
  await pool.query(`DELETE FROM product_events WHERE pubkey = $1`, [
    SELLER_PK,
  ]);
  await pool.query(
    `DELETE FROM rate_limit_counters
     WHERE (bucket LIKE 'ucp-checkout-%' AND (rate_key = $1 OR rate_key = $2))
        OR bucket = $3`,
    [SOURCE_IP, String(apiKeyId ?? -1), INIT_RATE_BUCKET]
  );
}

function createRequest(overrides: {
  method: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}) {
  return {
    method: overrides.method,
    headers: { authorization: `Bearer ${apiKeyPlaintext}` },
    query: overrides.query ?? {},
    body: overrides.body,
    socket: { remoteAddress: SOURCE_IP },
  } as any;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key];
    },
  } as any;
}

function expectEscalationShape(session: any) {
  expect(session.id).toBe(escalationSessionId);
  expect(session.status).toBe("requires_escalation");
  expect(typeof session.error).toBe("string");
  expect(session.error).toMatch(/exchange rate/i);
  expect(session.code).toBe("exchange_rate_unavailable");
  // A retriable pre-order escalation advertises its retry action.
  expect(session.links.retry).toBe(`${session.links.self}/retry`);
  const escalationMessage = (session.messages || []).find(
    (m: any) => m.type === "requires_escalation"
  );
  expect(escalationMessage).toBeDefined();
  expect(escalationMessage.severity).toBe("error");
}

describe("UCP checkout escalation round trip (real Postgres)", () => {
  maybeItTc(
    "POST persists the escalation with status, error, and code",
    async () => {
      expect(escalationSessionId).toMatch(/^ucp_cs_/);
      expectEscalationShape(escalationBody);

      // The row really landed: the code column insert is exercised for real.
      const rows = await db.getDbPool().query(
        `SELECT status, error, code, mcp_order_id
         FROM ucp_checkout_sessions WHERE id = $1`,
        [escalationSessionId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe("requires_escalation");
      expect(rows.rows[0].code).toBe("exchange_rate_unavailable");
      expect(rows.rows[0].error).toBe(escalationBody.error);
      expect(rows.rows[0].mcp_order_id).toBeNull();
    }
  );

  maybeItTc(
    "GET /api/ucp/checkout/sessions/[id] returns the saved escalation",
    async () => {
      const res = createResponse();
      await sessionByIdHandler(
        createRequest({ method: "GET", query: { id: escalationSessionId } }),
        res
      );
      expect(res.statusCode).toBe(200);
      expectEscalationShape(res.body);
    }
  );

  maybeItTc(
    "GET /api/ucp/checkout/sessions lists the saved escalation for the key",
    async () => {
      const res = createResponse();
      await sessionsHandler(createRequest({ method: "GET" }), res);
      expect(res.statusCode).toBe(200);
      const sessions = res.body.sessions as any[];
      const found = sessions.find((s) => s.id === escalationSessionId);
      expect(found).toBeDefined();
      expectEscalationShape(found);
    }
  );
});
