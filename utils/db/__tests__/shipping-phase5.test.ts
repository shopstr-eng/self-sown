/** @jest-environment node */

jest.setTimeout(180_000);

const maybeTest = process.env.RUN_TESTCONTAINERS === "1" ? test : test.skip;

maybeTest(
  "shares one atomic outbound-label claim across manual and automatic flows",
  async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:15-alpine")
      .withDatabase("shopstr")
      .withUsername("shopstr")
      .withPassword("shopstr")
      .start();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgres://shopstr:shopstr@${container.getHost()}:${container.getMappedPort(5432)}/shopstr`;

    try {
      const { Client } = await import("pg");
      const migrationClient = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      await migrationClient.connect();
      await migrationClient.query(`
        CREATE TABLE shipping_label_order_claims (
          claim_key TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          order_id TEXT NOT NULL,
          status TEXT NOT NULL,
          shipment_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await migrationClient.query(
        `INSERT INTO shipping_label_order_claims
           (claim_key, pubkey, order_id, status)
         VALUES ($1, $2, $3, 'pending')`,
        ["legacy-payment", "a".repeat(64), "legacy-order"]
      );
      await migrationClient.end();

      await jest.isolateModulesAsync(async () => {
        jest.resetModules();
        jest.unmock("pg");
        const db = await import("../db-service");
        const shipping = await import("../shipping-service");
        await db.getSellerOrderState("initialize", "a".repeat(64));

        const seller = "a".repeat(64);
        await expect(
          shipping.claimOutboundLabelPurchase(seller, "legacy-order")
        ).resolves.toBe(false);

        // Simulate a Phase 4 instance creating a claim after Phase 5's startup
        // migration has already copied the legacy table.
        await db.getDbPool().query(
          `INSERT INTO shipping_label_order_claims
             (claim_key, pubkey, order_id, status)
           VALUES ($1, $2, $3, 'pending')`,
          ["legacy-after-migration", seller, "legacy-after-migration"]
        );
        await expect(
          shipping.claimOutboundLabelPurchase(
            seller,
            "legacy-after-migration",
            `outbound:${seller}:new-instance`
          )
        ).resolves.toBe(false);

        await expect(
          shipping.claimOutboundLabelPurchase(
            seller,
            "phase5-first",
            `outbound:${seller}:phase5-first`
          )
        ).resolves.toBe(true);
        await expect(
          db.getDbPool().query(
            `INSERT INTO shipping_label_order_claims
               (claim_key, pubkey, order_id, status)
             VALUES ($1, $2, $3, 'pending')`,
            ["old-instance-second-key", seller, "phase5-first"]
          )
        ).rejects.toMatchObject({ code: "23505" });

        const attempts = await Promise.all(
          Array.from({ length: 12 }, () =>
            shipping.claimOutboundLabelPurchase(seller, "order-1")
          )
        );
        expect(attempts.filter(Boolean)).toHaveLength(1);

        await shipping.releaseOutboundLabelClaim(seller, "order-1");
        await expect(
          shipping.claimOutboundLabelPurchase(
            seller,
            "order-1",
            `outbound:${seller}:payment-1`
          )
        ).resolves.toBe(true);
        await shipping.markOutboundLabelPurchased(
          seller,
          "order-1",
          "shipment-1"
        );
        await shipping.releaseOutboundLabelClaim(seller, "order-1");
        await expect(
          shipping.claimOutboundLabelPurchase(seller, "order-1")
        ).resolves.toBe(false);

        await shipping.rememberShipmentOwner("shipment-2", seller, "order-2");
        await shipping.rememberShipmentOwner(
          "shipment-2",
          "b".repeat(64),
          "forged-order"
        );
        await expect(shipping.getShipmentClaim("shipment-2")).resolves.toEqual({
          shipmentId: "shipment-2",
          pubkey: seller,
          orderId: "order-2",
          status: "owned",
        });
        await expect(
          shipping.claimShipmentForPurchase("shipment-2", "b".repeat(64))
        ).resolves.toBe(false);
        await expect(
          shipping.claimShipmentForPurchase(
            "shipment-2",
            seller,
            "forged-order"
          )
        ).resolves.toBe(false);
        await expect(
          shipping.claimShipmentForPurchase("shipment-2", seller, "order-2")
        ).resolves.toBe(true);

        await db.closeDbPool();
      });
    } finally {
      process.env.DATABASE_URL = previousDatabaseUrl;
      await container.stop();
    }
  }
);
