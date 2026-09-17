// Synthetic public catalog fixtures sent only to the loopback test API.
const fs = require("node:fs");
const path = require("node:path");
const { finalizeEvent, getPublicKey } = require("nostr-tools");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const base = "http://127.0.0.1:5000";
const sellerKey = new Uint8Array(32).fill(41);
const common = [
  ["summary", "Fresh milk from our local test farm."],
  ["price", "12", "USD"],
  ["image", `${base}/milk-carton.png`],
  ["image", `${base}/milk-market.png`],
  ["t", "Milk"],
  ["location", "Austin"],
  ["status", "active"],
  ["quantity", "10"],
  ["shipping", "Free", "0", "USD"],
];
const products = [
  ["catalog-simple", "Farm fresh milk", []],
  [
    "catalog-options",
    "Milk with choices",
    [
      ["size", "SM", "0"],
      ["size", "LG", "4"],
      ["volume", "Quart", "12"],
      ["volume", "Gallon", "40"],
      ["weight", "1lbs", "18"],
      ["variant_label", "Flavor"],
      ["variant", "Plain"],
      ["variant", "Vanilla", `${base}/milk-carton.png`],
      ["variant_display", "dropdown"],
      ["bulk", "3", "30", "Quart"],
    ],
  ],
  ["catalog-common", "Three bottle bundle", [["bulk", "3", "24"]]],
  [
    "catalog-complex",
    "Website configured milk",
    [
      ["subscription", "true"],
      ["subscription_frequency", "weekly"],
      ["required", "Contact"],
      ["restrictions", "Local customers"],
      ["custom", "preserve", "extension"],
    ],
  ],
];
(async () => {
  const events = [];
  for (const [d, title, extra] of products) {
    const event = finalizeEvent(
      {
        kind: 30402,
        created_at: Math.floor(Date.now() / 1000),
        content: "Fresh milk from our local test farm.",
        tags: [["d", d], ["title", title], ...common, ...extra],
      },
      sellerKey
    );
    const response = await fetch(`${base}/api/db/cache-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok)
      throw new Error(`Catalog seed failed: ${response.status}`);
    events.push(event);
  }
  fs.writeFileSync(
    path.join(process.env.MILK_MOBILE_FIXTURE_DIR, "catalog.json"),
    JSON.stringify({ seller: getPublicKey(sellerKey), events }, null, 2)
  );
  console.log(`Seeded ${events.length} synthetic catalog products.`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
