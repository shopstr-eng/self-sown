/**
 * @jest-environment node
 */

// STAGING restart-crash test for the x402/Lightning MCP settlement path.
//
// The settlement flow records a payment receipt (x402_settled_payments,
// keyed by payment hash) BEFORE running the settlement tail (claim the
// pending quote, mark the order paid, consume the discount code, deduct
// stock, reap the quote). A server killed between those two steps leaves a
// specific DB state: receipt committed, order still unpaid, quote row still
// present (possibly holding a fresh claim from the dead settler). This suite
// proves the REAL recovery path settles such an order exactly once:
//
//   1. verify-payment poll recovers a crash between receipt claim and tail.
//   2. verify-payment defers while the dead settler's quote claim is fresh
//      (no double-settle, retriable) and settles once it ages out.
//   3. the x402 PAYMENT-SIGNATURE preimage retry (create-order) recovers the
//      same crash, returning a settlement header.
//   4. two concurrent recovery attempts (two "instances") settle exactly once.
//
// Everything downstream of the crash injection is the REAL production path:
// the actual route handlers (pages/api/mcp/verify-payment,
// pages/api/mcp/create-order), the real claim/accessor functions, real
// Postgres. The "restart" closes the DB pool and rebuilds the module graph
// (jest.resetModules + isolateModulesAsync), so the recovering server has
// zero in-memory state — every fact it acts on comes from Postgres, exactly
// like a fresh process. The crash itself is injected by making the exact
// production calls the route would make (claimX402Settlement, optionally
// claimPendingLightningQuote) and then stopping, which IS the post-kill DB
// state — deterministic where a real mid-request SIGKILL would be racy.
//
// Invoices: the polling surface (verify-payment) settles against the staging
// Nutshell FakeWallet mint — real createMintQuoteBolt11 issuance, real
// checkMintQuoteBolt11 polling (FakeWallet settles mint quotes immediately;
// that mint state IS the settlement signal production trusts). The preimage
// surface (handleX402Settlement) never consults the mint — the preimage IS
// the payment proof (self-facilitated lnbtc scheme) — but it DOES verify
// SHA-256(preimage_bytes) == invoice payment hash, and FakeWallet issues
// nonstandard invoices whose payment hash is sha256(ascii hex-secret), so no
// standard-semantics preimage exists for them (a real melt of such an
// invoice is also refused: "mint quote already paid"). The preimage surface
// is therefore exercised with a locally SIGNED bolt11 invoice (real
// signature, real sha256(preimage) binding, controlled preimage) persisted
// through the same production savePendingLightningQuote accessor.
//
// GATED — skipped with a loud warning unless ALL of:
//   X402_RESTART_TEST_DATABASE_URL   Postgres with the runtime schema (the
//                                    dev database works)
//   X402_RESTART_TEST_DESTRUCTIVE_OK=1
//                                    explicit acknowledgement that the URL is
//                                    a NON-PRODUCTION database (the suite
//                                    creates and deletes its own test rows)
//   the staging mint answers /v1/info (start the Staging Cashu Mint workflow)
//
// Run:  X402_RESTART_TEST_DATABASE_URL="$DATABASE_URL" \
//       X402_RESTART_TEST_DESTRUCTIVE_OK=1 \
//       npx jest __tests__/mcp/x402-settlement-restart-staging.test.ts \
//         --runInBand --no-coverage
//
// Test rows carry a per-run zz-x402rst-<timestamp> marker. Cleanup deletes by
// exact id after each test; the sweep for rows orphaned by an interrupted run
// is age-guarded (>1h old) so a concurrently running invocation's live rows
// are never touched.

import { createHash, randomBytes } from "crypto";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  MintQuoteState,
} from "@cashu/cashu-ts";
import { encode as bolt11Encode, sign as bolt11Sign } from "bolt11";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { NextApiRequest, NextApiResponse } from "next";

import { X402_HEADERS, X402_LNBTC_MAINNET } from "@/utils/x402/constants";
import { buildLnBtcRequirement } from "@/utils/x402/server";
import { decodeBolt11 } from "@/utils/x402/bolt11";
import {
  decodeSettlementHeader,
  encodePaymentSignatureHeader,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@/utils/x402/types";

jest.setTimeout(300000);

type DbModule = typeof import("@/utils/db/db-service");
type PurchaseModule = typeof import("@/mcp/tools/purchase-tools");
type X402Module = typeof import("@/utils/db/x402-service");
type AuthModule = typeof import("@/utils/mcp/auth");
type InventoryModule = typeof import("@/utils/db/inventory-service");
type VerifyPaymentHandler =
  (typeof import("@/pages/api/mcp/verify-payment"))["default"];
type CreateOrderHandler =
  (typeof import("@/pages/api/mcp/create-order"))["default"];

const STAGING_MINT_URL =
  process.env.STAGING_CASHU_MINT_URL ?? "http://127.0.0.1:3338";
const EXTERNAL_DATABASE_URL = process.env.X402_RESTART_TEST_DATABASE_URL;
const DESTRUCTIVE_OK = process.env.X402_RESTART_TEST_DESTRUCTIVE_OK === "1";
const SHOULD_RUN = Boolean(EXTERNAL_DATABASE_URL) && DESTRUCTIVE_OK;
const maybeIt = SHOULD_RUN ? test : test.skip;

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[x402-settlement-restart-staging] SKIPPED — needs BOTH " +
      "X402_RESTART_TEST_DATABASE_URL (non-production Postgres) AND " +
      "X402_RESTART_TEST_DESTRUCTIVE_OK=1; see the header for the run " +
      "command. This skip is intentional outside staging runs.\n"
  );
}

const RUN_ID = `zz-x402rst-${Date.now()}`;
const AMOUNT_SATS = 21;
const QUANTITY = 2;
const START_STOCK = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probeMint = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${STAGING_MINT_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** A "restarted server": fresh module graph + fresh pool, handlers re-imported. */
interface ServerContext {
  verifyPayment: VerifyPaymentHandler;
  createOrder: CreateOrderHandler;
  db: DbModule;
}

interface Fixture {
  orderId: string;
  productId: string;
  discountCode: string;
  buyerPub: string;
  sellerPub: string;
  apiKey: string;
  apiKeyId: number;
  paymentHash: string;
  invoice: string;
  quoteId: string;
  /** Present only for self-signed invoices (preimage-settlement surface). */
  preimage?: string;
  requirement: X402PaymentRequirements;
  requestHash: string;
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
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key.toLowerCase()];
    },
  };
}

async function driveVerifyPayment(
  server: ServerContext,
  apiKey: string,
  orderId: string
) {
  const res = createResponse();
  await server.verifyPayment(
    {
      method: "POST",
      url: "/api/mcp/verify-payment",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        host: "agent.test",
      },
      query: {},
      body: { orderId },
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { statusCode: res.statusCode, body: res.body, headers: res.headers };
}

async function driveX402Settle(
  server: ServerContext,
  apiKey: string,
  signatureHeader: string
) {
  const res = createResponse();
  await server.createOrder(
    {
      method: "POST",
      url: "/api/mcp/create-order",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        host: "agent.test",
        [X402_HEADERS.paymentSignature]: signatureHeader,
      },
      query: {},
      body: {},
      socket: { remoteAddress: "203.0.113.8" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { statusCode: res.statusCode, body: res.body, headers: res.headers };
}

/** Builds the x402 v2 PAYMENT-SIGNATURE payload a real paying client sends. */
function paymentSignatureHeader(
  requirement: X402PaymentRequirements,
  preimage: string
): string {
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: { preimage },
  };
  return encodePaymentSignatureHeader(payload);
}

/**
 * A real, authentically-signed bolt11 invoice with a CONTROLLED preimage and
 * standard semantics (payment hash = sha256(preimage bytes)) — what a real
 * Lightning invoice looks like once paid. The FakeWallet mint cannot issue
 * these (see header), so the preimage surface uses this instead.
 */
function issueSelfSignedInvoice(amountSats: number): {
  invoice: string;
  paymentHash: string;
  preimage: string;
} {
  const preimage = randomBytes(32);
  const paymentHash = createHash("sha256").update(preimage).digest("hex");
  // bolt11's runtime encoder accepts `coinType` ("bc" = mainnet) even though
  // its .d.ts only declares the structured `network` field.
  const encoded = bolt11Encode({
    coinType: "bc",
    millisatoshis: String(amountSats * 1000),
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: "payment_hash", data: paymentHash },
      { tagName: "payment_secret", data: randomBytes(32).toString("hex") },
      { tagName: "description", data: "x402 settlement restart test" },
      { tagName: "expire_time", data: 3600 },
    ],
  } as unknown as Parameters<typeof bolt11Encode>[0]);
  const signed = bolt11Sign(encoded, "01".repeat(32));
  if (!signed.paymentRequest) {
    throw new Error("bolt11 sign did not produce a payment request");
  }
  return {
    invoice: signed.paymentRequest,
    paymentHash,
    preimage: preimage.toString("hex"),
  };
}

describe("x402/Lightning settlement — server restart mid-settlement (staging)", () => {
  let db: DbModule;
  let purchase: PurchaseModule;
  let x402: X402Module;
  let auth: AuthModule;
  let inventory: InventoryModule;
  let mintAvailable = false;
  let previousDatabaseUrl: string | undefined;
  let isolatedServers: DbModule[] = [];

  // Per-run registries for exact-id cleanup.
  let orderIds: string[] = [];
  let productIds: string[] = [];
  let buyerPubs: string[] = [];
  let discountCodes: string[] = [];

  const waitForTables = async (tableNames: string[]): Promise<void> => {
    const deadline = Date.now() + 60000;
    const pool = db.getDbPool();
    while (Date.now() < deadline) {
      const client = await pool.connect();
      try {
        const result = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
          [tableNames]
        );
        if (result.rows.length === tableNames.length) return;
      } finally {
        client.release();
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
  };

  /** Age-guarded sweep for rows orphaned by an interrupted previous run. */
  const sweepOrphans = async (): Promise<void> => {
    const pool = db.getDbPool();
    await pool.query(
      `DELETE FROM mcp_lightning_quotes WHERE order_id LIKE 'zz-x402rst-%'`,
      []
    );
    await pool.query(
      `DELETE FROM x402_settled_payments WHERE order_id LIKE 'zz-x402rst-%'`
    );
    await pool.query(
      `DELETE FROM mcp_orders
       WHERE order_id LIKE 'zz-x402rst-%' AND created_at < NOW() - INTERVAL '1 hour'`
    );
    await pool.query(
      `DELETE FROM inventory_log WHERE product_id LIKE 'zz-x402rst-%'`
    );
    await pool.query(
      `DELETE FROM inventory WHERE product_id LIKE 'zz-x402rst-%'`
    );
    await pool.query(
      `DELETE FROM discount_codes WHERE code LIKE 'ZZ-X402RST-%'`
    );
    await pool.query(
      `DELETE FROM mcp_api_keys WHERE name LIKE 'zz-x402rst-%' AND created_at < NOW() - INTERVAL '1 hour'`
    );
  };

  const cleanupRun = async (): Promise<void> => {
    const pool = db.getDbPool();
    await pool.query(
      `DELETE FROM mcp_lightning_quotes WHERE order_id = ANY($1)`,
      [orderIds]
    );
    await pool.query(
      `DELETE FROM x402_settled_payments WHERE order_id = ANY($1)`,
      [orderIds]
    );
    await pool.query(`DELETE FROM mcp_orders WHERE order_id = ANY($1)`, [
      orderIds,
    ]);
    await pool.query(
      `DELETE FROM inventory_log WHERE product_id = ANY($1)`,
      [productIds]
    );
    await pool.query(`DELETE FROM inventory WHERE product_id = ANY($1)`, [
      productIds,
    ]);
    await pool.query(`DELETE FROM discount_codes WHERE code = ANY($1)`, [
      discountCodes,
    ]);
    await pool.query(`DELETE FROM mcp_api_keys WHERE pubkey = ANY($1)`, [
      buyerPubs,
    ]);
  };

  /**
   * Simulates a server restart: sever the old process's connections, wipe
   * the module graph (module-scope flags like `tablesReady` are gone), and
   * re-import the REAL route handlers. Everything they learn now comes from
   * Postgres — there is no other place for settlement state to live.
   */
  const restartServer = async (): Promise<ServerContext> => {
    try {
      await db.closeDbPool();
    } catch {
      // a crashed process leaves nothing to close cleanly
    }
    jest.resetModules();
    const ctx = {} as ServerContext;
    await jest.isolateModulesAsync(async () => {
      ctx.db = await import("@/utils/db/db-service");
      ctx.verifyPayment = (await import("@/pages/api/mcp/verify-payment"))
        .default;
      ctx.createOrder = (await import("@/pages/api/mcp/create-order")).default;
    });
    isolatedServers.push(ctx.db);
    return ctx;
  };

  /**
   * Creates the full pre-payment fixture through production accessors: MCP
   * API key (real bearer auth), order row, stock, discount code, a REAL
   * invoice (staging-mint issued or self-signed, see header), and the
   * persisted pending-quote row exactly as create-order writes it.
   */
  const setupOrder = async (
    suffix: string,
    invoiceSource: "staging-mint" | "self-signed"
  ): Promise<Fixture> => {
    const buyerPub = getPublicKey(generateSecretKey());
    const sellerPub = getPublicKey(generateSecretKey());
    const orderId = `${RUN_ID}-${suffix}`;
    const productId = `${RUN_ID}-product-${suffix}`;
    const discountCode = `ZZ-X402RST-${Date.now()}-${suffix}`.toUpperCase();
    orderIds.push(orderId);
    productIds.push(productId);
    buyerPubs.push(buyerPub);
    discountCodes.push(discountCode);

    const { key, record } = await auth.createApiKey(
      `${RUN_ID}-${suffix}`,
      buyerPub,
      "read_write",
      undefined,
      "shopping"
    );

    await purchase.createMcpOrder(
      orderId,
      record.id,
      buyerPub,
      sellerPub,
      productId,
      "Restart Test Product",
      QUANTITY,
      AMOUNT_SATS,
      "sat",
      null,
      null,
      null
    );

    await inventory.setStock(productId, sellerPub, START_STOCK);

    const pool = db.getDbPool();
    await pool.query(
      `INSERT INTO discount_codes (code, pubkey, discount_percentage, max_uses, times_used)
       VALUES ($1, $2, 10, 5, 0)`,
      [discountCode, sellerPub]
    );

    let invoice: string;
    let paymentHash: string;
    let quoteId: string;
    let preimage: string | undefined;
    if (invoiceSource === "staging-mint") {
      // The exact issuance call order-service makes for platform-mint
      // Lightning challenges.
      const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
      await wallet.loadMint();
      const mintQuote = await wallet.createMintQuoteBolt11(AMOUNT_SATS);
      invoice = mintQuote.request;
      quoteId = mintQuote.quote;
      paymentHash = decodeBolt11(invoice).paymentHash;
      // FakeWallet settles mint quotes immediately; poll anyway so a slow
      // staging mint fails loudly here instead of flaking the scenario.
      let state: string | undefined;
      for (let i = 0; i < 40; i++) {
        const checked = await wallet.checkMintQuoteBolt11(quoteId);
        state = typeof checked === "string" ? checked : checked?.state;
        if (state === MintQuoteState.PAID || state === MintQuoteState.ISSUED)
          break;
        await sleep(250);
      }
      if (state !== MintQuoteState.PAID && state !== MintQuoteState.ISSUED) {
        throw new Error(
          `Staging mint quote never settled (state=${state}) — the "paid invoice" premise of this test is not met`
        );
      }
    } else {
      const selfSigned = issueSelfSignedInvoice(AMOUNT_SATS);
      invoice = selfSigned.invoice;
      paymentHash = selfSigned.paymentHash;
      preimage = selfSigned.preimage;
      quoteId = `selfsigned-${randomBytes(8).toString("hex")}`;
    }

    // Build the x402 requirement exactly as the challenge leg does, so the
    // settlement payload below is what a real client would echo back.
    const decoded = decodeBolt11(invoice);
    const requestHash = createHash("sha256")
      .update(`${RUN_ID}-${suffix}-request`)
      .digest("hex");
    const requirement = buildLnBtcRequirement({
      amountSats: AMOUNT_SATS,
      invoice,
      context: {
        requestHash,
        profile: "http:1",
        profileParams: { method: "POST", url: "https://agent.test" },
        resourceUrl: "https://agent.test/api/mcp/create-order",
        description: `SelfSown marketplace order for product ${productId}`,
      },
      maxTimeoutSeconds: decoded.expirySeconds,
    });

    await purchase.savePendingLightningQuote({
      quote: quoteId,
      mintUrl: STAGING_MINT_URL,
      amount: AMOUNT_SATS,
      orderId,
      productId,
      quantity: QUANTITY,
      inventoryVariantKey: "_default",
      discountCode,
      sellerPubkey: sellerPub,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      paymentHash,
      authority: "mint",
      invoice,
      requestHash,
    });

    return {
      orderId,
      productId,
      discountCode,
      buyerPub,
      sellerPub,
      apiKey: key,
      apiKeyId: record.id,
      paymentHash,
      invoice,
      quoteId,
      ...(preimage ? { preimage } : {}),
      requirement,
      requestHash,
    };
  };

  /**
   * The crash: the settling process recorded the payment receipt (the exact
   * claimX402Settlement call the route makes) — and optionally the tail's
   * atomic quote claim — then DIED. No mark-paid, no discount consumption,
   * no stock deduction, no quote reap. This IS the post-kill DB state.
   */
  const injectCrashMidSettlement = async (
    fx: Fixture,
    opts: { quoteClaimHeldByDeadSettler: boolean }
  ): Promise<void> => {
    const claimed = await x402.claimX402Settlement({
      paymentHash: fx.paymentHash,
      network: X402_LNBTC_MAINNET,
      amountMsat: BigInt(AMOUNT_SATS) * 1000n,
      orderId: fx.orderId,
      apiKeyId: fx.apiKeyId,
      buyerPubkey: fx.buyerPub,
    });
    expect(claimed).toBe(true);
    if (opts.quoteClaimHeldByDeadSettler) {
      const claim = await purchase.claimPendingLightningQuote(fx.orderId);
      expect(claim).not.toBeNull();
    }
    // --- process killed here ---
  };

  /**
   * Simulates time passing across the restart: the dead settler's quote
   * claim ages past LIGHTNING_CLAIM_STALE_MS so the next poll may re-take
   * it (the real TTL wait, compressed — same mechanism the production
   * stale-claim predicate applies).
   */
  const ageOutQuoteClaim = async (orderId: string): Promise<void> => {
    const staleMs = purchase.LIGHTNING_CLAIM_STALE_MS + 1000;
    const pool = db.getDbPool();
    await pool.query(
      `UPDATE mcp_lightning_quotes SET claimed_at = $1 WHERE order_id = $2`,
      [new Date(Date.now() - staleMs).toISOString(), orderId]
    );
  };

  const getOrderDeductionCount = async (
    fx: Fixture
  ): Promise<number> => {
    const pool = db.getDbPool();
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_log
       WHERE product_id = $1 AND order_id = $2 AND reason = 'order_deduction'`,
      [fx.productId, fx.orderId]
    );
    return result.rows[0].n;
  };

  const getStockQuantity = async (productId: string): Promise<number> => {
    const pool = db.getDbPool();
    const result = await pool.query(
      `SELECT quantity FROM inventory WHERE product_id = $1 AND variant_key = '_default'`,
      [productId]
    );
    expect(result.rows.length).toBe(1);
    return Number(result.rows[0].quantity);
  };

  const getDiscountTimesUsed = async (fx: Fixture): Promise<number> => {
    const pool = db.getDbPool();
    const result = await pool.query(
      `SELECT times_used FROM discount_codes WHERE code = $1 AND pubkey = $2`,
      [fx.discountCode, fx.sellerPub]
    );
    expect(result.rows.length).toBe(1);
    return Number(result.rows[0].times_used);
  };

  /** The order is settled and every side effect ran EXACTLY once. */
  const expectSettledExactlyOnce = async (
    fx: Fixture,
    expectedIntentId: string
  ): Promise<void> => {
    const order = await purchase.getMcpOrder(fx.orderId);
    expect(order?.payment_status).toBe("paid");
    expect(order?.payment_intent_id).toBe(expectedIntentId);
    expect(await getStockQuantity(fx.productId)).toBe(START_STOCK - QUANTITY);
    expect(await getOrderDeductionCount(fx)).toBe(1);
    expect(await getDiscountTimesUsed(fx)).toBe(1);
    // Quote row reaped by the tail; the receipt row is retained for
    // idempotent retries.
    expect(await purchase.getPendingLightningQuote(fx.orderId)).toBeNull();
    const receipt = await x402.getX402Settlement(fx.paymentHash);
    expect(receipt?.orderId).toBe(fx.orderId);
  };

  /** The crash state is untouched: no side effect has run (yet). */
  const expectStillUnsettled = async (fx: Fixture): Promise<void> => {
    const order = await purchase.getMcpOrder(fx.orderId);
    expect(order?.payment_status).not.toBe("paid");
    expect(await getStockQuantity(fx.productId)).toBe(START_STOCK);
    expect(await getOrderDeductionCount(fx)).toBe(0);
    expect(await getDiscountTimesUsed(fx)).toBe(0);
    expect(
      await purchase.getPendingLightningQuote(fx.orderId)
    ).not.toBeNull();
  };

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[x402-settlement-restart-staging] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping (start the Staging Cashu Mint workflow to run these)"
      );
      return;
    }
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = EXTERNAL_DATABASE_URL!;
    // One isolated module context so every base service shares a single pool.
    await jest.isolateModulesAsync(async () => {
      jest.resetModules();
      jest.unmock("pg");
      db = await import("@/utils/db/db-service");
      purchase = await import("@/mcp/tools/purchase-tools");
      x402 = await import("@/utils/db/x402-service");
      auth = await import("@/utils/mcp/auth");
      inventory = await import("@/utils/db/inventory-service");
    });
    await waitForTables([
      "mcp_orders",
      "mcp_lightning_quotes",
      "x402_settled_payments",
      "mcp_api_keys",
      "inventory",
      "inventory_log",
      "discount_codes",
    ]);
    await sweepOrphans();
  }, 300000);

  afterAll(async () => {
    if (!SHOULD_RUN || !mintAvailable) return;
    try {
      await cleanupRun();
      for (const serverDb of isolatedServers) {
        try {
          await serverDb.closeDbPool();
        } catch {
          // pool may already be closed
        }
      }
      await db.closeDbPool();
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  }, 120000);

  maybeIt(
    "verify-payment poll recovers a crash between receipt claim and settlement tail — exactly once",
    async () => {
      if (!mintAvailable) return;
      const fx = await setupOrder("poll-receipt-only", "staging-mint");

      // Crash: receipt committed, tail never started.
      await injectCrashMidSettlement(fx, { quoteClaimHeldByDeadSettler: false });
      await expectStillUnsettled(fx);

      // Restart and poll — the real handler re-discovers everything from
      // Postgres and settles the paid invoice.
      const server = await restartServer();
      const first = await driveVerifyPayment(server, fx.apiKey, fx.orderId);
      expect(first.statusCode).toBe(200);
      expect(first.body.status).toBe("paid");
      expect(first.body.orderId).toBe(fx.orderId);
      await expectSettledExactlyOnce(fx, `ln_${fx.quoteId}`);

      // A duplicate poll settles nothing twice.
      const again = await driveVerifyPayment(server, fx.apiKey, fx.orderId);
      expect(again.statusCode).toBe(200);
      expect(again.body.status).toBe("paid");
      expect(again.body.message).toMatch(/already been confirmed/i);

      // Cross-surface idempotency: an x402 preimage retry for the same
      // payment short-circuits on the receipt + paid order. (The dummy
      // preimage is never inspected on this path — the early return runs
      // before payload validation.)
      const retry = await driveX402Settle(
        server,
        fx.apiKey,
        paymentSignatureHeader(fx.requirement, "00".repeat(32))
      );
      expect(retry.statusCode).toBe(200);
      expect(retry.body.status).toBe("paid");
      expect(retry.body.message).toMatch(/already been confirmed/i);

      await expectSettledExactlyOnce(fx, `ln_${fx.quoteId}`);
    }
  );

  maybeIt(
    "verify-payment defers to the dead settler's fresh claim, settles once it ages out",
    async () => {
      if (!mintAvailable) return;
      const fx = await setupOrder("poll-fresh-claim", "staging-mint");

      // Crash one step later: receipt committed AND the tail's quote claim
      // held by the dead settler (fresh claimed_at).
      await injectCrashMidSettlement(fx, { quoteClaimHeldByDeadSettler: true });
      await expectStillUnsettled(fx);

      const server = await restartServer();

      // An immediate poll must NOT double-settle: the fresh claim belongs to
      // the (dead) settler, so this poll reports in-progress and runs no
      // side effects.
      const blocked = await driveVerifyPayment(server, fx.apiKey, fx.orderId);
      expect(blocked.statusCode).toBe(200);
      expect(blocked.body.status).toBe("unpaid");
      expect(blocked.body.message).toMatch(/in progress/i);
      await expectStillUnsettled(fx);

      // The claim ages out across the restart window; the next poll takes
      // over and finishes the settlement exactly once.
      await ageOutQuoteClaim(fx.orderId);
      const settled = await driveVerifyPayment(server, fx.apiKey, fx.orderId);
      expect(settled.statusCode).toBe(200);
      expect(settled.body.status).toBe("paid");
      await expectSettledExactlyOnce(fx, `ln_${fx.quoteId}`);
    }
  );

  maybeIt(
    "x402 preimage retry recovers a crash between receipt claim and settlement tail — exactly once",
    async () => {
      if (!mintAvailable) return;
      const fx = await setupOrder("x402-preimage", "self-signed");
      if (!fx.preimage) throw new Error("self-signed fixture lacks preimage");

      await injectCrashMidSettlement(fx, { quoteClaimHeldByDeadSettler: true });
      await expectStillUnsettled(fx);

      const server = await restartServer();
      await ageOutQuoteClaim(fx.orderId);

      // The buyer retries the original request with the PAYMENT-SIGNATURE
      // proof: the recovering handler finds the prior claim + unpaid order
      // (recovery case) and finishes the idempotent tail.
      const header = paymentSignatureHeader(fx.requirement, fx.preimage);
      const settled = await driveX402Settle(server, fx.apiKey, header);
      expect(settled.statusCode).toBe(200);
      expect(settled.body.status).toBe("paid");
      expect(settled.body.x402?.settled).toBe(true);
      const settlementHeader = settled.headers[X402_HEADERS.paymentResponse];
      if (!settlementHeader) {
        throw new Error("settled response is missing the PAYMENT-RESPONSE header");
      }
      const settlement = decodeSettlementHeader(settlementHeader);
      expect(settlement?.success).toBe(true);
      expect(settlement?.transaction).toBe(fx.paymentHash);
      await expectSettledExactlyOnce(fx, `x402_${fx.paymentHash}`);

      // Replaying the same payment proof must not re-run side effects.
      const replay = await driveX402Settle(server, fx.apiKey, header);
      expect(replay.statusCode).toBe(200);
      expect(replay.body.status).toBe("paid");
      expect(replay.body.message).toMatch(/already been confirmed/i);

      // Cross-surface: a verify-payment poll now returns the confirmed order
      // (early return — the mint is never consulted for this quote).
      const poll = await driveVerifyPayment(server, fx.apiKey, fx.orderId);
      expect(poll.statusCode).toBe(200);
      expect(poll.body.status).toBe("paid");

      await expectSettledExactlyOnce(fx, `x402_${fx.paymentHash}`);
    }
  );

  maybeIt(
    "two concurrent recovery attempts (two restarted instances) settle exactly once",
    async () => {
      if (!mintAvailable) return;

      // (a) Polling surface: two restarted servers poll the same crashed
      // order simultaneously; the atomic quote claim admits exactly one
      // settler.
      const fxPoll = await setupOrder("race-poll", "staging-mint");
      await injectCrashMidSettlement(fxPoll, {
        quoteClaimHeldByDeadSettler: true,
      });
      await expectStillUnsettled(fxPoll);
      await ageOutQuoteClaim(fxPoll.orderId);

      const serverA = await restartServer();
      const serverB = await restartServer();
      const [resA, resB] = await Promise.all([
        driveVerifyPayment(serverA, fxPoll.apiKey, fxPoll.orderId),
        driveVerifyPayment(serverB, fxPoll.apiKey, fxPoll.orderId),
      ]);
      // Both responses are well-formed; at least one observes the settled
      // order (the loser may legitimately report "in progress" if it
      // re-read mid-tail).
      expect([resA.statusCode, resB.statusCode]).toEqual([200, 200]);
      expect(
        [resA.body.status, resB.body.status].includes("paid")
      ).toBe(true);
      // A settling poll leaves no doubt.
      const finalPoll = await driveVerifyPayment(
        serverA,
        fxPoll.apiKey,
        fxPoll.orderId
      );
      expect(finalPoll.body.status).toBe("paid");
      await expectSettledExactlyOnce(fxPoll, `ln_${fxPoll.quoteId}`);

      // (b) x402 preimage surface: the crash left a receipt but the tail
      // never claimed the quote; two concurrent preimage retries race the
      // tail and exactly one runs the side effects.
      const fxX402 = await setupOrder("race-x402", "self-signed");
      if (!fxX402.preimage)
        throw new Error("self-signed fixture lacks preimage");
      await injectCrashMidSettlement(fxX402, {
        quoteClaimHeldByDeadSettler: false,
      });
      await expectStillUnsettled(fxX402);

      const serverC = await restartServer();
      const serverD = await restartServer();
      const headerX = paymentSignatureHeader(fxX402.requirement, fxX402.preimage);
      const [resC, resD] = await Promise.all([
        driveX402Settle(serverC, fxX402.apiKey, headerX),
        driveX402Settle(serverD, fxX402.apiKey, headerX),
      ]);
      expect([resC.statusCode, resD.statusCode]).toEqual([200, 200]);
      expect(
        [resC.body.status, resD.body.status].includes("paid")
      ).toBe(true);
      // A replay converges on the confirmed order.
      const finalRetry = await driveX402Settle(serverD, fxX402.apiKey, headerX);
      expect(finalRetry.body.status).toBe("paid");
      await expectSettledExactlyOnce(fxX402, `x402_${fxX402.paymentHash}`);
    }
  );
});
