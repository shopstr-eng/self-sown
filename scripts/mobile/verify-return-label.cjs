// Real signed HTTP/SQL checks for the isolated native return-label walkthrough.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { finalizeEvent } = require("nostr-tools");
const { Client } = require("pg");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const directory = process.env.MILK_MOBILE_FIXTURE_DIR;
const fixture = JSON.parse(
  fs.readFileSync(path.join(directory, "fixture.json"))
);
const base = "http://127.0.0.1:5000";
const route = "/api/shipping/return-label";
const body = {
  orderId: fixture.orderId,
  from: {
    name: "Ada Test",
    street1: "12 Market St",
    street2: "Apt 4",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
  },
  parcel: { weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 4 },
  carriers: ["USPS"],
};
async function request(input, byte = 41, signedBody = input) {
  const proof = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", base + route],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(signedBody)).digest("hex"),
        ],
      ],
    },
    new Uint8Array(32).fill(byte)
  );
  const response = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Nostr " + Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
}
(async () => {
  const wrongSeller = await request(body, 43);
  assert.equal(wrongSeller.status, 403);
  const tampered = await request({ ...body, orderId: "tampered" }, 41, body);
  assert.equal(tampered.status, 401);
  const invalid = await request({ ...body, parcel: { weightOz: -1 } });
  assert.equal(invalid.status, 400);
  if (process.argv.includes("--after-purchase")) {
    const db = new Client({
      connectionString:
        "postgres://milk_mobile:milk_mobile_local@127.0.0.1:55436/milk_mobile",
    });
    await db.connect();
    try {
      const labels = (
        await db.query(
          "SELECT order_id, is_return, tracking_code, from_summary, to_summary FROM shipping_labels WHERE pubkey=$1 AND order_id=$2 ORDER BY purchased_at DESC",
          [fixture.seller, fixture.orderId]
        )
      ).rows;
      assert.equal(labels.filter((label) => label.is_return).length, 1);
      const duplicate = await request(body);
      assert.equal(duplicate.status, 409);
      const status = (
        await db.query(
          "SELECT status FROM seller_order_states WHERE order_id=$1 AND seller_pubkey=$2",
          [fixture.orderId, fixture.seller]
        )
      ).rows;
      assert.equal(status[0].status, "shipped");
      const calls = fs
        .readFileSync(path.join(directory, "shipping.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const purchases = calls.filter(
        (call) =>
          call.url.endsWith("/transactions/") &&
          call.body.rate === "mobile-local-return-rate"
      );
      assert.equal(purchases.length, 1);
      fs.writeFileSync(
        path.join(directory, "return-verification.json"),
        JSON.stringify(
          {
            wrongSeller,
            tampered,
            invalid,
            duplicate,
            labels,
            status,
            returnTransactions: purchases.length,
          },
          null,
          2
        )
      );
    } finally {
      await db.end();
    }
  }
  console.log(
    "Return-label signed HTTP checks passed" +
      (process.argv.includes("--after-purchase")
        ? "; one return purchase persisted and status unchanged."
        : "; ready for native purchase.")
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
