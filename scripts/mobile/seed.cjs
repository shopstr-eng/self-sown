const fs = require("node:fs");
const path = require("node:path");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const { Client } = require("pg");
const {
  finalizeEvent,
  getPublicKey,
  getEventHash,
  nip19,
  nip44,
  generateSecretKey,
} = require("nostr-tools");
const sellerKey = new Uint8Array(32).fill(41);
const buyerKey = new Uint8Array(32).fill(42);
const seller = getPublicKey(sellerKey),
  buyer = getPublicKey(buyerKey);
const now = Math.floor(Date.now() / 1000);
const event = (kind, tags, content, key = sellerKey) =>
  finalizeEvent({ kind, tags, content, created_at: now }, key);
const common = [
  ["summary", "Local simulator shipping regression fixture."],
  ["price", "12", "USD"],
  ["image", "http://127.0.0.1:5000/favicon.ico"],
  ["t", "Milk"],
  ["location", "Austin"],
  ["status", "active"],
  ["quantity", "10"],
  ["ship_from_zip", "78701", "US"],
  ["parcel", "16", "10", "8", "4"],
];
const product = event(
  30402,
  [
    ["d", "mobile-local-milk"],
    ["title", "Mobile Local Local Milk"],
    ["shipping", "Added Cost", "5", "USD"],
    ...common,
  ],
  ""
);
const webProduct = event(
  30402,
  [
    ["d", "mobile-local-web-shipping"],
    ["title", "Mobile Local Web Shipping"],
    ["shipping_option", `30406:${seller}:standard`, "2"],
    ["shipping", "Added Cost/Pickup", "7.50", "EUR"],
    ["pickup_location", "Farm gate"],
    ["ships_to", "US"],
    ...common,
  ],
  ""
);
const profile = event(
  0,
  [],
  JSON.stringify({
    name: "Mobile Local Test Farm",
    display_name: "Mobile Local Test Farm",
    about: "Local Docker and Xcode test seller",
  })
);
const rumor = {
  kind: 14,
  pubkey: buyer,
  created_at: now,
  content: "Order for Mobile Local Local Milk",
  tags: [
    ["p", seller],
    ["subject", "order-info"],
    ["order", "mobile-local-local-order"],
    ["item", `30402:${seller}:mobile-local-milk`, "1"],
    ["amount", "12"],
    ["currency", "USD"],
    [
      "address",
      "Ada Test, 12 Market St, Apt 4, Austin, TX, 78701, United States of America",
    ],
  ],
};
rumor.id = getEventHash(rumor);
const seal = event(
  13,
  [],
  nip44.encrypt(
    JSON.stringify(rumor),
    nip44.getConversationKey(buyerKey, seller)
  ),
  buyerKey
);
const ephemeral = generateSecretKey();
const wrap = event(
  1059,
  [["p", seller]],
  nip44.encrypt(
    JSON.stringify(seal),
    nip44.getConversationKey(ephemeral, seller)
  ),
  ephemeral
);
(async () => {
  const route = "http://127.0.0.1:5000/api/mobile/notifications/devices";
  const proof = finalizeEvent(
    {
      kind: 27235,
      created_at: now,
      content: "",
      tags: [
        ["u", route],
        ["method", "GET"],
      ],
    },
    sellerKey
  );
  const ready = await fetch(route, {
    headers: {
      Authorization:
        "Nostr " + Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
  });
  if (!ready.ok)
    throw new Error(
      "Local notification API must be running before seeding (" +
        ready.status +
        ")"
    );

  const db = new Client({
    connectionString:
      "postgres://milk_mobile:milk_mobile_local@127.0.0.1:55436/milk_mobile",
  });
  await db.connect();
  for (const [table, e] of [
    ["product_events", product],
    ["product_events", webProduct],
    ["profile_events", profile],
    ["message_events", wrap],
  ]) {
    await db.query(
      `INSERT INTO ${table} (id,pubkey,created_at,kind,tags,content,sig) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [
        e.id,
        e.pubkey,
        e.created_at,
        e.kind,
        JSON.stringify(e.tags),
        e.content,
        e.sig,
      ]
    );
  }
  await db.query(
    "UPDATE message_events SET order_id='mobile-local-local-order' WHERE id=$1",
    [wrap.id]
  );
  await db.query(
    "INSERT INTO pro_memberships(pubkey,status,lifetime) VALUES ($1,'active',true) ON CONFLICT(pubkey) DO UPDATE SET status='active',lifetime=true",
    [seller]
  );
  await db.query(
    "INSERT INTO shipping_oauth_connections(pubkey,access_token,account_id,status) VALUES ($1,'oauth.mobile-local-local','mobile-local-local','connected') ON CONFLICT(pubkey) DO NOTHING",
    [seller]
  );
  await db.query(
    "INSERT INTO shipping_defaults(pubkey,from_name,from_street1,from_city,from_state,from_zip,from_country,preferred_carriers,auto_purchase_labels) VALUES ($1,'Test Farm','1 Farm Rd','Austin','TX','78701','US',ARRAY['USPS'],false) ON CONFLICT(pubkey) DO NOTHING",
    [seller]
  );
  fs.writeFileSync(
    path.join(process.env.MILK_MOBILE_FIXTURE_DIR, "fixture.json"),
    JSON.stringify(
      {
        seller,
        buyer,
        nsec: nip19.nsecEncode(sellerKey),
        orderId: "mobile-local-local-order",
        productId: product.id,
        webProductId: webProduct.id,
        wrapId: wrap.id,
      },
      null,
      2
    )
  );
  console.log({
    seller,
    orderId: "mobile-local-local-order",
    productId: product.id,
    webProductId: webProduct.id,
  });
  await db.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
