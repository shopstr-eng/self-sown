/**
 * x402 E2E staging setup: seeds a staging seller into the dev database and
 * wires its x402 invoice authority at a stub LNbits node, using the real
 * public APIs wherever they exist.
 *
 * Steps:
 *   1. Regenerate the deterministic staging seller (reuses
 *      scripts/e2e-setup-staging-seller.mjs) and insert its signed
 *      kind:30402 product into product_events (what relay sync would write),
 *      plus authed_sellers and a lifetime Pro grant in pro_memberships.
 *   2. POST /api/x402/authority with a real signed kind-27235 Nostr proof to
 *      point the seller's x402 invoices at the stub (key verified live by
 *      the route against the stub before saving).
 *   3. Onboard a buyer MCP key (audience shopping) and a seller MCP key
 *      (audience seller, bound to the seller nsec) via /api/mcp/onboard.
 *
 * Writes /tmp/x402-e2e-context.json for scripts/e2e-x402-external-agent.mjs.
 *
 * Env: BASE_URL (app, default https://$REPLIT_DEV_DOMAIN:5000),
 *      STUB_BASE (public URL of the stub, default https://$REPLIT_DEV_DOMAIN),
 *      STUB_LNBITS_KEY, NEON_DATABASE_URL.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { finalizeEvent, nip19 } from "nostr-tools";

const BASE_URL = (
  process.env.BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}:5000`
).replace(/\/+$/, "");
const STUB_BASE = (
  process.env.STUB_BASE || `https://${process.env.REPLIT_DEV_DOMAIN}`
).replace(/\/+$/, "");
const STUB_KEY = process.env.STUB_LNBITS_KEY || "x402-e2e-stub-key";

// Mirror getDbPool() in utils/db/db-service.ts: DATABASE_URL, with the Neon
// endpoint host rewritten to its pooler variant.
const RAW_DB_URL = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!RAW_DB_URL) throw new Error("DATABASE_URL is not set");
const dbUrlObj = new URL(RAW_DB_URL);
const endpoint = dbUrlObj.hostname.split(".")[0] ?? "";
if (dbUrlObj.hostname.endsWith(".neon.tech") && !endpoint.endsWith("-pooler")) {
  dbUrlObj.hostname = dbUrlObj.hostname.replace(/^([^.]+)\./, "$1-pooler.");
}
const DB_URL = dbUrlObj.toString();

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

// --- 1. staging seller fixture -------------------------------------------
console.log("[setup] regenerating staging seller fixture...");
execFileSync(process.execPath, ["scripts/e2e-setup-staging-seller.mjs"], {
  stdio: "inherit",
});
const fixture = JSON.parse(
  fs.readFileSync("/tmp/staging-seller-events.json", "utf8")
);
const sellerPk = fixture.sellerPk;
const sellerSk = hexToBytes(fixture.sellerSkHex);
const product = fixture.product;
console.log("[setup] seller pubkey:", sellerPk);
console.log("[setup] product id:", product.id);

const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: DB_URL });

await pool.query(
  `INSERT INTO product_events (id, pubkey, created_at, kind, tags, content, sig)
   VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
   ON CONFLICT (id) DO NOTHING`,
  [
    product.id,
    product.pubkey,
    product.created_at,
    product.kind,
    JSON.stringify(product.tags),
    product.content,
    product.sig,
  ]
);
await pool.query(
  `INSERT INTO authed_sellers (pubkey) VALUES ($1) ON CONFLICT (pubkey) DO NOTHING`,
  [sellerPk]
);
// Lifetime (Wrangler) grant — mirrors LIFETIME_GRANT_SQL in
// utils/db/pro-membership.ts.
await pool.query(
  `INSERT INTO pro_memberships
     (pubkey, billing_method, term, lifetime, status, stripe_customer_id,
      cancel_at_period_end, updated_at)
   VALUES ($1, 'manual', NULL, TRUE, 'active', NULL, FALSE, now())
   ON CONFLICT (pubkey) DO UPDATE SET
     billing_method = 'manual', term = NULL, lifetime = TRUE, status = 'active',
     stripe_subscription_id = NULL, current_period_end = NULL,
     grace_until = NULL, readonly_until = NULL, cancel_at_period_end = FALSE,
     updated_at = now()`,
  [sellerPk]
);
console.log("[setup] product_events + authed_sellers + lifetime Pro seeded");

// --- 2. x402 invoice authority via the real signed-proof API --------------
const proof = finalizeEvent(
  {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["action", "x402_authority"],
      ["method", "POST"],
      ["path", "/api/x402/authority"],
      ["pubkey", sellerPk],
    ],
  },
  sellerSk
);
const authorityRes = await fetch(`${BASE_URL}/api/x402/authority`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mcp-signed-event": JSON.stringify(proof),
  },
  body: JSON.stringify({
    provider: "lnbits",
    url: STUB_BASE,
    apiKey: STUB_KEY,
  }),
});
const authorityBody = await authorityRes.json().catch(() => null);
if (!authorityRes.ok) {
  throw new Error(
    `[setup] authority save failed: HTTP ${authorityRes.status} ${JSON.stringify(authorityBody)}`
  );
}
console.log("[setup] x402 authority saved:", authorityBody.authority.url);

// --- 3. MCP keys -----------------------------------------------------------
async function onboard(body) {
  const res = await fetch(`${BASE_URL}/api/mcp/onboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.apiKey) {
    throw new Error(
      `[setup] onboard failed (${body.audience}): HTTP ${res.status} ${JSON.stringify(data)}`
    );
  }
  return data;
}

const buyer = await onboard({
  name: "x402 E2E external buyer",
  audience: "shopping",
});
console.log("[setup] buyer key onboarded, pubkey:", buyer.pubkey);

const seller = await onboard({
  name: "x402 E2E staging seller",
  audience: "seller",
  permissions: "read_write",
  pubkey: sellerPk,
  nsec: nip19.nsecEncode(sellerSk),
});
if (seller.pubkey !== sellerPk) {
  throw new Error(
    `[setup] seller onboard bound to wrong pubkey: ${seller.pubkey}`
  );
}
console.log("[setup] seller key onboarded");

const context = {
  baseUrl: BASE_URL,
  stubBase: STUB_BASE,
  stubApiKey: STUB_KEY,
  sellerPubkey: sellerPk,
  productId: product.id,
  productTitle: "Staging Escrow Test Item",
  buyerApiKey: buyer.apiKey,
  buyerPubkey: buyer.pubkey,
  sellerApiKey: seller.apiKey,
};
fs.writeFileSync(
  "/tmp/x402-e2e-context.json",
  JSON.stringify(context, null, 2)
);
await pool.end();
console.log("[setup] wrote /tmp/x402-e2e-context.json");
console.log("[setup] DONE");
