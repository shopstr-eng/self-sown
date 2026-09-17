/** @jest-environment node */
import { catalogEvent } from "../../../packages/domain/src/__fixtures__/seller-catalog";

jest.setTimeout(180000);
const suite = process.env.RUN_TESTCONTAINERS === "1" ? describe : describe.skip;
suite("seller catalog inventory persistence", () => {
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
    await db.cacheEvent(catalogEvent());
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
  test("replaying a signed product does not restore stock already sold", async () => {
    const event = catalogEvent([
      ["size", "SM", "4"],
      ["quantity", "10"],
    ]);
    await db.cacheEvent(event);
    await inventory.deductStock(event.id, 1, "sale-1", "size:SM");
    await inventory.deductStock(event.id, 2, "sale-2");
    await Promise.all(Array.from({ length: 16 }, () => db.cacheEvent(event)));
    expect(await inventory.getStock(event.id, "size:SM")).toEqual({
      tracked: true,
      quantity: 3,
    });
    expect(await inventory.getStock(event.id)).toEqual({
      tracked: true,
      quantity: 8,
    });
  });
  test("zero is tracked and different revisions and sellers have isolated inventory", async () => {
    const event = catalogEvent([["size", "SM", "0"]]);
    await db.cacheEvent(event);
    const other = {
      ...event,
      id: "2".repeat(64),
      pubkey: "c".repeat(64),
      tags: [...event.tags.filter((t) => t[0] !== "size"), ["size", "SM", "5"]],
    };
    await db.cacheEvent(other);
    expect(await inventory.getStock(event.id, "size:SM")).toEqual({
      tracked: true,
      quantity: 0,
    });
    expect(await inventory.getStock(other.id, "size:SM")).toEqual({
      tracked: true,
      quantity: 5,
    });
  });
  test("failed initialization rejects and can be retried without partial quantities", async () => {
    const event = catalogEvent([
      ["quantity", "8"],
      ["size", "SM", "4"],
    ]);
    const pool = db.getDbPool();
    await pool.query(
      "ALTER TABLE inventory ADD CONSTRAINT fixture_reject_size CHECK (variant_key <> 'size:SM')"
    );
    try {
      await expect(db.cacheEvent(event)).rejects.toThrow();
      expect(await inventory.getStock(event.id)).toEqual({
        tracked: false,
        quantity: -1,
      });
    } finally {
      await pool.query(
        "ALTER TABLE inventory DROP CONSTRAINT fixture_reject_size"
      );
    }
    await db.cacheEvent(event);
    expect(await inventory.getStock(event.id)).toEqual({
      tracked: true,
      quantity: 8,
    });
    expect(await inventory.getStock(event.id, "size:SM")).toEqual({
      tracked: true,
      quantity: 4,
    });
  });
});
