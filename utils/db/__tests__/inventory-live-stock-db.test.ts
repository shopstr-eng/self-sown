/** @jest-environment node */
import { catalogEvent } from "../../../packages/domain/src/__fixtures__/seller-catalog";

// Real-Postgres coverage for the batch stock read behind the newer-wins rule.
// Skipped unless RUN_TESTCONTAINERS=1 (needs Docker), like the other *-db tests.

jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
suite("batch stock read with row timestamps", () => {
  let db: typeof import("../db-service");
  let inventory: typeof import("../inventory-service");
  let stop: () => Promise<unknown>;
  const previousUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(
      "postgres:15-alpine"
    ).start();
    stop = () => container.stop();
    process.env.DATABASE_URL = container.getConnectionUri();
    db = await import("../db-service");
    inventory = await import("../inventory-service");
    await db.ensureTablesInitialized();
    await inventory.ensureInventoryTable();
  });

  afterAll(async () => {
    if (db) await db.closeDbPool();
    if (stop) await stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  beforeEach(async () => {
    await db
      .getDbPool()
      .query("TRUNCATE inventory, inventory_log, product_events");
  });

  test("returns every requested product in one call and omits untracked ones", async () => {
    const a = catalogEvent([["quantity", "10"]]);
    const b = { ...a, id: "2".repeat(64), tags: [["quantity", "4"]] };
    await db.cacheEvent(a);
    await db.cacheEvent(b);
    await inventory.deductStock(a.id, 3, "sale-1");

    const stock = await inventory.getStockForProducts([
      a.id,
      b.id,
      a.id,
      "9".repeat(64),
    ]);

    expect([...stock.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(stock.get(a.id)?.default_quantity).toBe(7);
    expect(stock.get(b.id)?.default_quantity).toBe(4);
  });

  test("separates default and size rows, each with its own timestamp", async () => {
    const event = catalogEvent([
      ["quantity", "8"],
      ["size", "SM", "4"],
    ]);
    await db.cacheEvent(event);
    await inventory.deductStock(event.id, 1, "sale-1", "size:SM");

    const snapshot = (await inventory.getStockForProducts([event.id])).get(
      event.id
    )!;

    expect(snapshot.default_quantity).toBe(8);
    expect(snapshot.variants).toEqual({ "size:SM": 3 });
    expect(typeof snapshot.default_updated_at).toBe("number");
    expect(typeof snapshot.variant_updated_at?.["size:SM"]).toBe("number");
  });

  test("an empty or blank id list does not query", async () => {
    expect((await inventory.getStockForProducts([])).size).toBe(0);
    expect((await inventory.getStockForProducts([""])).size).toBe(0);
  });

  test("getAllStock keeps its shape and now carries timestamps", async () => {
    const event = catalogEvent([["quantity", "5"]]);
    await db.cacheEvent(event);
    const all = await inventory.getAllStock(event.id);
    expect(all.default_quantity).toBe(5);
    expect(all.variants).toEqual({});
    expect(typeof all.default_updated_at).toBe("number");
    expect(await inventory.getAllStock("8".repeat(64))).toEqual({
      default_quantity: null,
      variants: {},
    });
  });

  // updated_at is a plain TIMESTAMP, so the stored value follows the session
  // time zone. The epoch we report must still be the real time in any zone.
  test.each(["UTC", "America/Los_Angeles", "Asia/Kolkata"])(
    "reports real unix seconds when the database runs in %s",
    async (zone) => {
      const { rows } = await db
        .getDbPool()
        .query("SELECT current_database() AS name");
      const name = rows[0].name as string;
      await db
        .getDbPool()
        .query(`ALTER DATABASE "${name}" SET timezone TO '${zone}'`);
      // New connections pick up the database time zone, so drop the old pool.
      await db.closeDbPool();
      try {
        const event = catalogEvent([["quantity", "2"]]);
        await db.cacheEvent(event);
        const before = Math.floor(Date.now() / 1000);
        await inventory.deductStock(event.id, 1, `sale-${zone}`);
        const after = Math.ceil(Date.now() / 1000);

        const snapshot = (await inventory.getStockForProducts([event.id])).get(
          event.id
        )!;

        expect(snapshot.default_updated_at).toBeGreaterThanOrEqual(before - 2);
        expect(snapshot.default_updated_at).toBeLessThanOrEqual(after + 2);
      } finally {
        await db.getDbPool().query(`ALTER DATABASE "${name}" RESET timezone`);
        await db.closeDbPool();
      }
    }
  );
});
