const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { verifyEvent } = require("nostr-tools");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR ||
  process.env.DATABASE_URL !==
    "postgres://milk_mobile:milk_mobile_local@127.0.0.1:55436/milk_mobile"
)
  throw new Error("Explicit loopback fixture database required");
const directory = process.env.MILK_MOBILE_FIXTURE_DIR;
const fixture = JSON.parse(
  fs.readFileSync(path.join(directory, "catalog.json"), "utf8")
);
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const checks = [];
  try {
    for (const event of fixture.events) {
      const response = await fetch("http://127.0.0.1:5000/api/db/cache-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      assert.equal(response.status, 200);
      const result = await client.query(
        "SELECT tags FROM product_events WHERE id=$1",
        [event.id]
      );
      assert.deepEqual(result.rows[0].tags, event.tags);
      assert.equal(verifyEvent(event), true);
      checks.push({
        name: "signed product readback",
        id: event.id,
        pass: true,
      });
    }
    const tampered = { ...fixture.events[0], content: "Tampered content" };
    const rejected = await fetch("http://127.0.0.1:5000/api/db/cache-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    assert.equal(rejected.status, 401);
    checks.push({ name: "tampered signature rejected", pass: true });
    const latest = await client.query(
      "SELECT DISTINCT ON (tags->0->>1) id,tags FROM product_events WHERE pubkey=$1 ORDER BY tags->0->>1,created_at DESC,id",
      [fixture.seller]
    );
    const report = {
      verifiedAt: new Date().toISOString(),
      checks,
      latestProducts: latest.rows,
    };
    fs.writeFileSync(
      path.join(directory, "catalog-verification.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(`${checks.length} signed HTTP/readback checks passed.`);
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
