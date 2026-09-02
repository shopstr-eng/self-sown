/**
 * Creates a deterministic staging seller (keypair from a fixed seed so the
 * fixture is reproducible), signs a kind:30019 shop profile with
 * storefront.acceptsEscrow=true and a cheap sats-priced kind:30402 product,
 * writes them to /tmp/staging-seller-events.json for DB insertion, and
 * best-effort publishes both to the public relays.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, SimplePool } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { createHash } from "node:crypto";
import fs from "node:fs";

// Deterministic keypair: sha256 of a fixed label. Staging fixture only.
const sellerSk = createHash("sha256")
  .update("milk-market-staging-escrow-seller-v1")
  .digest();
const sellerPk = getPublicKey(sellerSk);
console.log("seller pubkey:", sellerPk);

const now = Math.floor(Date.now() / 1000);

const shopProfile = finalizeEvent(
  {
    kind: 30019,
    created_at: now,
    tags: [["d", `shop-profile-${sellerPk.slice(0, 8)}`]],
    content: JSON.stringify({
      name: "Staging Escrow Seller",
      about: "Automated staging fixture for escrow recovery verification.",
      ui: { picture: "", banner: "", theme: "", darkMode: false },
      merchants: [sellerPk],
      storefront: { acceptsEscrow: true },
    }),
  },
  sellerSk
);

const dTag = `staging-escrow-test-item-${sellerSk.slice(0, 4).join("")}`;
const product = finalizeEvent(
  {
    kind: 30402,
    created_at: now,
    tags: [
      ["d", dTag],
      ["title", "Staging Escrow Test Item"],
      ["summary", "Cheap sats-priced fixture used to exercise escrow checkout in staging."],
      ["price", "100", "SATS"],
      ["location", "United States of America"],
      ["shipping", "Free", "0", "SATS"],
      ["t", "Digital"],
      ["quantity", "100"],
      ["status", "active"],
      ["required", "Address"],
      ["published_at", String(now)],
    ],
    content: "",
  },
  sellerSk
);

fs.writeFileSync(
  "/tmp/staging-seller-events.json",
  JSON.stringify({ sellerPk, sellerSkHex: bytesToHex(sellerSk), shopProfile, product }, null, 2)
);
console.log("product event id:", product.id);
console.log("product d-tag:", dTag);
console.log("wrote /tmp/staging-seller-events.json");

// Best-effort relay publish (DB insert is the authoritative path).
try {
  const pool = new SimplePool();
  const relays = ["wss://relay.damus.io", "wss://nos.lol"];
  const results = await Promise.allSettled(
    pool.publish(relays, shopProfile).concat(pool.publish(relays, product))
  );
  console.log(
    "relay publish:",
    results.map((r) => r.status).join(",")
  );
  pool.close(relays);
} catch (e) {
  console.log("relay publish skipped:", String(e).slice(0, 120));
}
