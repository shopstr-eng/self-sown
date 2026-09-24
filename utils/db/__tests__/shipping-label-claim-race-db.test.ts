/**
 * @jest-environment node
 */

// Real-database money-safety proof for the shared per-(seller, order) label
// purchase claim (shipping_label_order_claims). The mock suites in
// __tests__/api/shipping/buy-label.test.ts and
// __tests__/utils/shipping/auto-purchase.test.ts CANNOT prove the race —
// their claim mocks resolve sequentially. Against a real Postgres:
//
//   1. A manual dashboard purchase (pages/api/shipping/buy-label route) and
//      an agent/webhook purchase (runAutoLabelPurchase) fired CONCURRENTLY for
//      the same order produce exactly ONE Shippo charge; the loser resolves to
//      claimed-by-other/already-bought (route: 409) and buys nothing.
//   2. N simultaneous claimAutoLabelPurchase calls on one key: exactly one
//      wins the INSERT ... ON CONFLICT DO NOTHING.
//   3. Once the claim is 'purchased', NEITHER path can ever buy again.
//   4. A lost claim reconciled against a successful Shippo transaction is
//      promoted to 'purchased' and its history backfilled (never re-bought).
//   5. A lost claim whose Shippo transaction was CHARGED but returned no
//      label metadata still permanently blocks rebuying (money was spent).
//   6. A stale pending claim with NO Shippo transaction is released and the
//      retry proceeds — a crashed attempt can't brick an order.
//
// Everything at the money boundary is REAL: the claim rows, the shipment
// ownership rows, the label history rows, and the unique index on
// (pubkey, order_id). Only the Shippo HTTP boundary (getRates / buyLabel /
// transaction lookup — buyLabel IS the charge) and the auth gates (rate
// limit, listed-seller, Pro, proof burn) are mocked. The signed-event proof
// itself is real: the route gets a properly signed kind-27235 event.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   SHIPPING_CLAIM_RACE_TEST_DATABASE_URL=postgres://...
//                                   — runs against an existing Postgres
//                                     (e.g. the dev database). All test rows
//                                     are namespaced behind one fixed
//                                     synthetic seller pubkey and deleted in
//                                     afterEach/afterAll.

jest.setTimeout(300000);

// Module marker: keeps the type aliases below out of the global script scope.
export {};

type DbServiceModule = typeof import("../db-service");
type ShippingServiceModule = typeof import("../shipping-service");
type AutoPurchaseModule = typeof import("@/utils/shipping/auto-purchase");
type BuyLabelRoute = typeof import("@/pages/api/shipping/buy-label").default;

// --- Mocks: Shippo charge boundary + auth gates only ----------------------

const getRatesMock = jest.fn();
const buyLabelMock = jest.fn();
const findTxMock = jest.fn();

jest.mock("@/utils/shipping/shippo", () => ({
  getRates: (...args: unknown[]) => getRatesMock(...args),
  buyLabel: (...args: unknown[]) => buyLabelMock(...args),
  lookupShipmentCharge: (...args: unknown[]) => findTxMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: () => true,
}));

jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: async () => true,
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: async () => true,
}));

jest.mock("@/utils/shipping/shipment-owners", () => ({
  isListedSeller: async () => true,
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: async () => true,
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  consumeSignedRequestProof: async () => true,
}));

const parseTagsMock = jest.fn();
jest.mock("@/utils/parsers/product-parser-functions", () => ({
  __esModule: true,
  default: (...args: unknown[]) => parseTagsMock(...args),
}));

import {
  buildMcpRequestProofTemplate,
  buildShippingBuyLabelProof,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";
import { buildLabelReconcileToken } from "@/utils/shipping/claim-reconcile";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { NextApiRequest, NextApiResponse } from "next";

// Fixed synthetic seller keypair: deterministic so an interrupted previous
// run's rows are swept by the equality cleanup in beforeAll/afterAll.
const SELLER_SK = new Uint8Array(32).fill(7);
const SELLER_PK = getPublicKey(SELLER_SK);

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL = process.env.SHIPPING_CLAIM_RACE_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeIt = SHOULD_RUN ? test : test.skip;

const TABLES = [
  "shipping_label_order_claims",
  "shipping_shipment_claims",
  "shipping_labels",
  "shipping_oauth_connections",
];

const TO_ADDRESS = {
  name: "Buyer Person",
  street1: "100 Buyer St",
  city: "Buyerville",
  state: "CA",
  zip: "90001",
  country: "US",
};

const PRODUCT_EVENT = {
  id: "prod_evt_race",
  pubkey: SELLER_PK,
  created_at: 1,
  kind: 30402,
  tags: [] as string[][],
  content: "",
  sig: "",
};

let db: DbServiceModule;
let shipping: ShippingServiceModule;
let autoPurchase: AutoPurchaseModule;
let buyLabelRoute: BuyLabelRoute;
let stopDatabase: (() => Promise<void>) | null = null;
let previousDatabaseUrl: string | undefined;
let orderCounter = 0;

function nextOrderId(): string {
  orderCounter += 1;
  return `race-order-${Date.now()}-${orderCounter}`;
}

function claimKeyFor(orderId: string): string {
  return `outbound:${SELLER_PK}:${orderId}`;
}

function fakeLabel(shipmentId: string) {
  return {
    shipmentId,
    trackingCode: "TRK123",
    trackingUrl: "https://track.example/TRK123",
    labelUrl: "https://labels.example/label.pdf",
    labelFormat: "PDF",
    rate: "5.00",
    currency: "USD",
    carrier: "USPS",
    service: "Ground Advantage",
  };
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
  // lazily on first use. Restored in afterAll.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  // Load db-service, shipping-service, the auto-purchase core, AND the route
  // inside ONE isolated module context so they share a single connection
  // pool (shipping-service imports getDbPool from db-service; the route and
  // auto-purchase both import shipping-service).
  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("../db-service");
    shipping = await import("../shipping-service");
    autoPurchase = await import("@/utils/shipping/auto-purchase");
    buyLabelRoute = (await import("@/pages/api/shipping/buy-label")).default;
  });

  await waitForTables(TABLES);
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
  }
}, 120000);

afterEach(async () => {
  if (!SHOULD_RUN) return;
  await cleanupTestRows();
});

beforeEach(() => {
  jest.clearAllMocks();

  parseTagsMock.mockReturnValue({
    shipFromZip: "10001",
    shipFromCountry: "US",
    packageWeightOz: 16,
    packageLengthIn: 6,
    packageWidthIn: 4,
    packageHeightIn: 2,
  });

  // Small delays widen the race window so both attempts are in flight when
  // the loser's claim INSERT collides with the winner's.
  getRatesMock.mockImplementation(async () => {
    await sleep(50);
    return {
      shipmentId: `shp_auto_${Date.now()}`,
      cheapest: {
        id: "rate_auto_1",
        rate: "5.00",
        currency: "USD",
        carrier: "USPS",
        service: "Ground Advantage",
      },
    };
  });
  buyLabelMock.mockImplementation(async (_token: string, args: { shipmentId: string }) => {
    await sleep(50);
    return fakeLabel(args.shipmentId);
  });
  findTxMock.mockResolvedValue({
    label: null,
    chargeState: "none",
    coveredWindow: true,
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  await pool.query(
    `DELETE FROM shipping_label_order_claims WHERE pubkey = $1`,
    [SELLER_PK]
  );
  await pool.query(
    `DELETE FROM shipping_shipment_claims WHERE pubkey = $1`,
    [SELLER_PK]
  );
  await pool.query(`DELETE FROM shipping_labels WHERE pubkey = $1`, [
    SELLER_PK,
  ]);
  await pool.query(
    `DELETE FROM shipping_oauth_connections WHERE pubkey = $1`,
    [SELLER_PK]
  );
}

/** Invoke the real buy-label route with a genuinely signed proof event. */
async function invokeBuyLabelRoute(args: {
  shipmentId: string;
  rateId: string;
  orderId: string;
}): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const template = buildMcpRequestProofTemplate(
    buildShippingBuyLabelProof({
      pubkey: SELLER_PK,
      shipmentId: args.shipmentId,
      rateId: args.rateId,
      orderId: args.orderId,
    })
  );
  const signedEvent = finalizeEvent(template, SELLER_SK);

  const req = {
    method: "POST",
    headers: { [MCP_SIGNED_EVENT_HEADER]: JSON.stringify(signedEvent) },
    body: {
      shipmentId: args.shipmentId,
      rateId: args.rateId,
      orderId: args.orderId,
    },
  } as unknown as NextApiRequest;

  const outcome = { statusCode: 200, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      outcome.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      outcome.body = payload;
      return this;
    },
  } as unknown as NextApiResponse;

  await buyLabelRoute(req, res);
  return outcome;
}

async function countLabelsForOrder(orderId: string): Promise<number> {
  const pool = db.getDbPool();
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM shipping_labels
     WHERE pubkey = $1 AND order_id = $2 AND is_return = false`,
    [SELLER_PK, orderId]
  );
  return Number(result.rows[0]?.n || 0);
}

maybeIt(
  "races a dashboard buy against an agent auto-purchase: exactly one charge, loser fails closed",
  async () => {
    const orderId = nextOrderId();
    const routeShipmentId = `shp_route_${orderId}`;

    // Seed the seller's connected Shippo account (real row) and register the
    // quoted shipment the dashboard route will buy (real ownership row).
    await shipping.upsertShippoConnection({
      pubkey: SELLER_PK,
      accessToken: "oauth.test-token",
    });
    await shipping.rememberShipmentOwner(routeShipmentId, SELLER_PK);

    const [routeResult, autoResult] = await Promise.all([
      invokeBuyLabelRoute({
        shipmentId: routeShipmentId,
        rateId: "rate_manual_1",
        orderId,
      }),
      autoPurchase.runAutoLabelPurchase({
        sellerPubkey: SELLER_PK,
        orderId,
        productEvent: PRODUCT_EVENT,
        toAddress: { ...TO_ADDRESS },
      }),
    ]);

    // Exactly one charge at the Shippo boundary — the double-charge proof.
    expect(buyLabelMock).toHaveBeenCalledTimes(1);

    const routeWon = routeResult.statusCode === 200;
    const autoWon = autoResult.purchased;
    expect(Number(routeWon) + Number(autoWon)).toBe(1);

    // The loser resolved to a fail-closed outcome and charged nothing.
    if (!routeWon) {
      expect(routeResult.statusCode).toBe(409);
    }
    if (!autoWon) {
      expect(autoResult.reason).toMatch(/^(claimed-by-other|already-bought)$/);
    }

    // The shared order claim ended as a permanent 'purchased' marker and
    // exactly one label history row exists for the order.
    const claim = await shipping.getAutoLabelClaim(claimKeyFor(orderId));
    expect(claim?.status).toBe("purchased");
    expect(await countLabelsForOrder(orderId)).toBe(1);
  }
);

maybeIt(
  "N concurrent raw claims on one (seller, order) key: exactly one winner",
  async () => {
    const orderId = nextOrderId();
    const key = claimKeyFor(orderId);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        shipping.claimAutoLabelPurchase(key, SELLER_PK, orderId)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    // The held claim is released cleanly by its single winner.
    await shipping.releaseAutoLabelClaim(key);
    expect(await shipping.getAutoLabelClaim(key)).toBeNull();
  }
);

maybeIt(
  "once the claim is 'purchased', neither path can ever buy again",
  async () => {
    const orderId = nextOrderId();
    const routeShipmentId = `shp_route_${orderId}`;

    await shipping.upsertShippoConnection({
      pubkey: SELLER_PK,
      accessToken: "oauth.test-token",
    });
    await shipping.rememberShipmentOwner(routeShipmentId, SELLER_PK);

    // Simulate a fully settled earlier purchase: permanent claim marker +
    // history row.
    await shipping.claimAutoLabelPurchase(claimKeyFor(orderId), SELLER_PK, orderId);
    await shipping.markAutoLabelPurchased(claimKeyFor(orderId), "shp_settled");
    await shipping.insertShippingLabel({
      pubkey: SELLER_PK,
      shipmentId: "shp_settled",
      orderId,
      trackingCode: "TRK0",
      trackingUrl: null,
      labelUrl: "https://labels.example/settled.pdf",
      labelFormat: "PDF",
      rateUsd: 5.0,
      currency: "USD",
      carrier: "USPS",
      service: "Ground Advantage",
      isReturn: false,
    });

    const [routeResult, autoResult] = await Promise.all([
      invokeBuyLabelRoute({
        shipmentId: routeShipmentId,
        rateId: "rate_manual_1",
        orderId,
      }),
      autoPurchase.runAutoLabelPurchase({
        sellerPubkey: SELLER_PK,
        orderId,
        productEvent: PRODUCT_EVENT,
        toAddress: { ...TO_ADDRESS },
      }),
    ]);

    expect(buyLabelMock).not.toHaveBeenCalled();
    expect(routeResult.statusCode).toBe(409);
    expect(autoResult).toEqual({ purchased: false, reason: "already-bought" });
    expect(await countLabelsForOrder(orderId)).toBe(1);
  }
);

maybeIt(
  "a lost claim with a proven Shippo charge reconciles to already-bought and is never re-bought",
  async () => {
    const orderId = nextOrderId();
    const key = claimKeyFor(orderId);
    const orphanedShipment = `shp_orphan_${orderId}`;

    await shipping.upsertShippoConnection({
      pubkey: SELLER_PK,
      accessToken: "oauth.test-token",
    });

    // Seed the ambiguous-failure state: a pending claim with the shipment id
    // AND reconcile token attached (the pre-charge reconciliation handle),
    // backdated past the in-flight window so reconciliation may settle it.
    await shipping.claimAutoLabelPurchase(
      key,
      SELLER_PK,
      orderId,
      orphanedShipment,
      buildLabelReconcileToken(key)
    );
    await db.getDbPool().query(
      `UPDATE shipping_label_order_claims
         SET updated_at = NOW() - INTERVAL '5 minutes'
       WHERE claim_key = $1`,
      [key]
    );

    // Shippo's transaction list proves the earlier attempt DID charge.
    findTxMock.mockResolvedValue({
      label: fakeLabel(orphanedShipment),
      chargeState: "charged",
      coveredWindow: true,
    });

    const result = await autoPurchase.runAutoLabelPurchase({
      sellerPubkey: SELLER_PK,
      orderId,
      productEvent: PRODUCT_EVENT,
      toAddress: { ...TO_ADDRESS },
    });

    expect(result).toEqual({ purchased: false, reason: "already-bought" });
    expect(buyLabelMock).not.toHaveBeenCalled();

    // Reconciliation promoted the claim and backfilled the history row.
    const claim = await shipping.getAutoLabelClaim(key);
    expect(claim?.status).toBe("purchased");
    expect(await countLabelsForOrder(orderId)).toBe(1);
  }
);

maybeIt(
  "a charge WITHOUT label metadata still permanently blocks rebuying",
  async () => {
    const orderId = nextOrderId();
    const key = claimKeyFor(orderId);
    const noLabelShipment = `shp_nolabel_${orderId}`;

    await shipping.upsertShippoConnection({
      pubkey: SELLER_PK,
      accessToken: "oauth.test-token",
    });

    // A timed-out attempt left a pending claim; Shippo shows the transaction
    // was CHARGED but returned no usable label metadata (SUCCESS without
    // label_url — buyLabel itself throws on that response).
    await shipping.claimAutoLabelPurchase(
      key,
      SELLER_PK,
      orderId,
      noLabelShipment,
      buildLabelReconcileToken(key)
    );
    await db.getDbPool().query(
      `UPDATE shipping_label_order_claims
         SET updated_at = NOW() - INTERVAL '5 minutes'
       WHERE claim_key = $1`,
      [key]
    );
    findTxMock.mockResolvedValue({
      label: null,
      chargeState: "charged",
      coveredWindow: true,
    });

    const result = await autoPurchase.runAutoLabelPurchase({
      sellerPubkey: SELLER_PK,
      orderId,
      productEvent: PRODUCT_EVENT,
      toAddress: { ...TO_ADDRESS },
    });

    // Money was spent: already-bought, the claim is permanently 'purchased',
    // and NO second charge is attempted — even though no label history row
    // could be backfilled (the claim marker is the only billing record).
    expect(result).toEqual({ purchased: false, reason: "already-bought" });
    expect(buyLabelMock).not.toHaveBeenCalled();
    expect((await shipping.getAutoLabelClaim(key))?.status).toBe("purchased");
    expect(await countLabelsForOrder(orderId)).toBe(0);
  }
);

maybeIt(
  "a stale pending claim with no Shippo charge is released and the retry proceeds",
  async () => {
    const orderId = nextOrderId();
    const key = claimKeyFor(orderId);
    const deadShipment = `shp_dead_${orderId}`;

    await shipping.upsertShippoConnection({
      pubkey: SELLER_PK,
      accessToken: "oauth.test-token",
    });

    // A crashed attempt left a pending claim (shipment attached, no charge).
    await shipping.claimAutoLabelPurchase(
      key,
      SELLER_PK,
      orderId,
      deadShipment,
      buildLabelReconcileToken(key)
    );
    await db.getDbPool().query(
      `UPDATE shipping_label_order_claims
         SET updated_at = NOW() - INTERVAL '5 minutes'
       WHERE claim_key = $1`,
      [key]
    );

    // Shippo proves no successful transaction exists for the dead shipment.
    findTxMock.mockResolvedValue({
      label: null,
      chargeState: "none",
      coveredWindow: true,
    });

    const result = await autoPurchase.runAutoLabelPurchase({
      sellerPubkey: SELLER_PK,
      orderId,
      productEvent: PRODUCT_EVENT,
      toAddress: { ...TO_ADDRESS },
    });

    expect(result.purchased).toBe(true);
    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    expect((await shipping.getAutoLabelClaim(key))?.status).toBe("purchased");
    expect(await countLabelsForOrder(orderId)).toBe(1);
  }
);
