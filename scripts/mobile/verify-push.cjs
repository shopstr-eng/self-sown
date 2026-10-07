// Exercise real HTTP auth/routes/SQL/worker with the isolated provider capture.
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Client } = require("pg");
const {
  finalizeEvent,
  nip44,
  getEventHash,
  generateSecretKey,
} = require("nostr-tools");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const directory = process.env.MILK_MOBILE_FIXTURE_DIR;
const fixture = JSON.parse(
  readFileSync(path.join(directory, "fixture.json"), "utf8")
);
const base = "http://127.0.0.1:5000";
async function request(route, method = "GET", body, byte = 41) {
  const content = body ? JSON.stringify(body) : undefined;
  const tags = [
    ["u", base + route],
    ["method", method],
  ];
  if (content)
    tags.push(["payload", createHash("sha256").update(content).digest("hex")]);
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    },
    new Uint8Array(32).fill(byte)
  );
  return fetch(base + route, {
    method,
    headers: {
      Authorization:
        "Nostr " + Buffer.from(JSON.stringify(auth)).toString("base64"),
      "Content-Type": "application/json",
    },
    body: content,
  });
}
(async () => {
  const root = "/api/mobile/notifications";
  assert.equal((await fetch(base + root + "/devices")).status, 401);
  const installationId = randomUUID();
  let response = await request(root + "/challenge", "POST", {
    installationId,
    token: "ExpoPushToken[local_fixture]",
    platform: "ios",
  });
  assert.equal(response.status, 200);
  const challenge = await response.json();
  const messages = readFileSync(path.join(directory, "push.jsonl"), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => JSON.parse(line).body);
  const delivered = messages.find(
    (message) => message.data?.challengeId === challenge.challengeId
  );
  assert.ok(delivered);
  response = await request(root + "/devices", "POST", {
    installationId,
    challengeId: challenge.challengeId,
    nonce: delivered.data.nonce,
  });
  assert.equal(response.status, 200);
  const device = await response.json();
  assert.equal(
    (
      await request(root + "/devices", "POST", {
        installationId,
        challengeId: challenge.challengeId,
        nonce: delivered.data.nonce,
      })
    ).status,
    409
  );
  const db = new Client({
    connectionString:
      "postgres://milk_mobile:milk_mobile_local@127.0.0.1:55436/milk_mobile",
  });
  await db.connect();
  const now = Math.floor(Date.now() / 1000);
  const buyerKey = new Uint8Array(32).fill(42);
  const rumor = {
    kind: 14,
    pubkey: fixture.buyer,
    created_at: now,
    content: "Local notification order",
    tags: [
      ["p", fixture.seller],
      ["subject", "order-info"],
      ["order", fixture.orderId],
      ["item", `30402:${fixture.seller}:mobile-local-milk`, "1"],
      ["amount", "12"],
      ["currency", "USD"],
    ],
  };
  rumor.id = getEventHash(rumor);
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: now,
      tags: [],
      content: nip44.encrypt(
        JSON.stringify(rumor),
        nip44.getConversationKey(buyerKey, fixture.seller)
      ),
    },
    buyerKey
  );
  const ephemeral = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: now,
      tags: [["p", fixture.seller]],
      content: nip44.encrypt(
        JSON.stringify(seal),
        nip44.getConversationKey(ephemeral, fixture.seller)
      ),
    },
    ephemeral
  );
  await db.query(
    "INSERT INTO message_events(id,pubkey,created_at,kind,tags,content,sig) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      event.id,
      event.pubkey,
      event.created_at,
      event.kind,
      JSON.stringify(event.tags),
      event.content,
      event.sig,
    ]
  );
  response = await fetch(base + root + "/process", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.MOBILE_PUSH_PROCESSOR_SECRET,
    },
  });
  assert.equal(response.status, 200);
  const counters = await response.json();
  assert.equal(counters.result.accepted, 1);
  const activity = (
    await db.query(
      "SELECT id FROM mobile_notification_activity WHERE message_id=$1",
      [event.id]
    )
  ).rows[0];
  assert.equal((await request(root + "/activity/" + activity.id)).status, 200);
  assert.equal(
    (await request(root + "/activity/" + activity.id, "GET", undefined, 42))
      .status,
    404
  );
  const sends = readFileSync(path.join(directory, "push.jsonl"), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => JSON.parse(line).body)
    .filter((m) => m.data?.type === "seller_activity");
  assert.equal(sends.length, 1);
  assert.deepEqual(Object.keys(sends[0].data).sort(), [
    "activityId",
    "type",
    "version",
  ]);
  writeFileSync(
    path.join(directory, "activity.apns"),
    JSON.stringify(
      {
        SimulatorTargetBundle: "com.milkmarket.mobile.local",
        aps: { alert: { title: sends[0].title, body: sends[0].body } },
        // Expo's iOS adapter reads remote custom data from userInfo.body.
        body: sends[0].data,
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(directory, "push-verification.json"),
    JSON.stringify(
      { deviceId: device.deviceId, activityId: activity.id, ...counters },
      null,
      2
    )
  );
  console.log(
    "Local HTTP verification passed: challenge, one-time confirmation, worker, opaque payload and seller authorization."
  );
  await db.end();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
