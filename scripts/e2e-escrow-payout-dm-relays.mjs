/**
 * Staging e2e: prove escrow payout notification DMs reach a payee on
 * NON-DEFAULT NIP-65 relays (task: payout-DM relay delivery).
 *
 * No browser needed — the whole flow is HTTP + Nostr + Cashu:
 *   0. probe candidate non-default relays, pick 2 that respond
 *   1. publish kind:10002 relay lists (payees READ only the non-default pair)
 *      and mirror seller+buyer's into the server relay cache via
 *      /api/db/cache-event (the app's own write path)
 *   2. RELEASE leg: buyer registers + release-approves, seller witnesses and
 *      completes → payout worker finalizes → gift wrap must appear on the
 *      seller's NON-DEFAULT relays; decrypted rumor must name the escrow
 *   3. REFUND leg: short lock, buyer witnesses post-expiry → refund → the
 *      buyer's non-default relays must get the wrap
 *   4. FALLBACK leg: a seller whose kind:10002 is published to relays (incl.
 *      the NIP-65 indexers) but NOT in the server cache — the server's live
 *      indexer fallback in getRecipientReadRelays must still deliver the wrap
 *      to the payee's own non-default relays. (Pass expectDelivery:false to
 *      legRelease to regression-check the pre-fallback degradation instead.)
 *
 * Usage: node scripts/e2e-escrow-payout-dm-relays.mjs
 * Requires: dev server on :5000 (escrow flags set), staging mint on :3338,
 * FLOW_PROCESSOR_SECRET in env. Gift-wrap timestamps are randomized, so relay
 * queries filter by #p only (fresh keypairs per run → any wrap is ours).
 */
import {
  Mint,
  Wallet,
  signP2PKProofs,
} from "@cashu/cashu-ts";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip44,
} from "nostr-tools";
import { useWebSocketImplementation, SimplePool } from "nostr-tools/pool";
import { bytesToHex } from "nostr-tools/utils";
import WebSocket, { WebSocketServer } from "ws";
import pg from "pg";

// Minimal in-process Nostr relay: serves stored events for matching REQs.
// Both public NIP-65 indexers are unreachable from this sandbox (egress
// proxy), so the fallback leg points the server's NIP65_INDEXER_RELAYS
// override at this local relay to prove the indexer-fetch branch end-to-end.
const FAKE_INDEXER_PORT = Number(process.env.E2E_FAKE_INDEXER_PORT ?? 14777);
function startFakeIndexer(storedEvents) {
  const wss = new WebSocketServer({ port: FAKE_INDEXER_PORT, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg[0] === "REQ") {
        const subId = msg[1];
        const filters = msg.slice(2);
        for (const ev of storedEvents) {
          const matches = filters.some(
            (f) =>
              (!f.kinds || f.kinds.includes(ev.kind)) &&
              (!f.authors || f.authors.includes(ev.pubkey))
          );
          if (matches) ws.send(JSON.stringify(["EVENT", subId, ev]));
        }
        ws.send(JSON.stringify(["EOSE", subId]));
      } else if (msg[0] === "EVENT") {
        storedEvents.push(msg[1]);
        ws.send(JSON.stringify(["OK", msg[1].id, true, ""]));
      } else if (msg[0] === "CLOSE") {
        ws.send(JSON.stringify(["CLOSED", msg[1], ""]));
      }
    });
  });
  return wss;
}

useWebSocketImplementation(WebSocket);

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5000";
// The commitment's mint tag must match the server allowlist exactly. Prefer a
// loopback entry (testnut charges input fees the exact-amount flows can't
// cover — see e2e-escrow-recovery.mjs) and fall back to the first entry.
const ALLOWED_MINTS = (process.env.CASHU_ESCROW_ALLOWED_MINTS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const MINT =
  ALLOWED_MINTS.find((u) =>
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u)
  ) ??
  ALLOWED_MINTS[0] ??
  (process.env.E2E_MINT_URL ?? "http://localhost:3338").replace(/\/+$/, "");
const FLOW_SECRET = process.env.FLOW_PROCESSOR_SECRET;

// cashu-ts v4 returns proof amounts as Amount instances that JSON-serialize
// as strings; the payout worker's payload shape check requires real numbers.
const toPlainProofs = (proofs) =>
  proofs.map((p) => ({
    ...p,
    amount:
      typeof p.amount === "number"
        ? p.amount
        : typeof p.amount?.toNumber === "function"
          ? p.amount.toNumber()
          : Number(p.amount),
  }));

// The server's delivery set on a cache HIT is payee-read-relays ∪ defaults ∪
// blastr; on a MISS it is only defaults ∪ blastr. Test relays must be in
// NEITHER (and must not be NIP-65 indexers, so leg 4 stays honest).
const DEFAULTS_PLUS_BLAST = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://sendit.nosflare.com",
];
const NON_DEFAULT_CANDIDATES = [
  "wss://nostr.mom",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
  "wss://relay.noswhere.com",
];

const pool = new SimplePool();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`RESULT ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` — ${detail}` : ""}`);
};

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `POST ${path} -> ${res.status}: ${json?.error || JSON.stringify(json)}`
    );
  }
  return json;
}

// ── Escrow event signing (canonical shapes the server re-derives) ───────────

function signCommitment({ buyerSk, sellerPk, orderId, amountSats, expiresAt }) {
  const escrowId = `${getPublicKey(buyerSk)}:${orderId}`;
  const content = JSON.stringify({
    amountSats,
    expiresAt,
    mintUrl: MINT,
    orderId,
    sellerPubkey: sellerPk,
  });
  const event = finalizeEvent(
    {
      kind: 31995,
      created_at: nowSec(),
      content,
      tags: [
        ["d", escrowId],
        ["order", orderId],
        ["seller", sellerPk],
        ["amount", String(amountSats)],
        ["mint", MINT],
        ["expiration", String(expiresAt)],
      ],
    },
    buyerSk
  );
  return { event, escrowId };
}

function signAction(sk, action, escrowId) {
  return finalizeEvent(
    {
      kind: 31996,
      created_at: nowSec(),
      content: JSON.stringify({ action, escrowId }),
      tags: [
        ["d", escrowId],
        ["action", action],
      ],
    },
    sk
  );
}

// ── Cashu helpers (mirrors utils/cashu/__tests__/escrow-lock-live.test.ts) ──

async function mintProofs(wallet, amount) {
  const quote = await wallet.createMintQuoteBolt11(amount);
  let state;
  for (let i = 0; i < 40; i++) {
    const checked = await wallet.checkMintQuoteBolt11(quote.quote);
    state = typeof checked === "string" ? checked : checked?.state;
    if (state === "PAID" || state === "ISSUED") break;
    await sleep(250);
  }
  if (state !== "PAID" && state !== "ISSUED") {
    throw new Error(`mint quote never settled (state=${state})`);
  }
  return wallet.mintProofsBolt11(amount, quote.quote);
}

async function lockForEscrow(wallet, proofs, amount, sellerPk, buyerPk, expiresAt) {
  const { keep, send } = await wallet.send(
    amount,
    proofs,
    { includeFees: true },
    {
      send: {
        type: "p2pk",
        options: {
          pubkey: sellerPk,
          locktime: expiresAt,
          refundKeys: [buyerPk],
          sigFlag: "SIG_INPUTS",
        },
      },
    }
  );
  return { keep, locked: send };
}

// ── Relay helpers ────────────────────────────────────────────────────────────

async function publishTo(relays, event) {
  const out = pool.publish(relays, event);
  const settled = await Promise.allSettled(Array.isArray(out) ? out : [out]);
  return settled.filter((s) => s.status === "fulfilled").length;
}

async function probeRelay(relay) {
  try {
    await Promise.race([
      pool.querySync([relay], { kinds: [1], limit: 1 }),
      sleep(9000).then(() => {
        throw new Error("timeout");
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function publishRelayList(sk, readRelays, { cache }) {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: nowSec(),
      content: "",
      tags: readRelays.map((url) => ["r", url]),
    },
    sk
  );
  const published = await publishTo(
    [...DEFAULTS_PLUS_BLAST, ...readRelays],
    event
  );
  log(
    `kind:10002 for ${getPublicKey(sk).slice(0, 8)}… published to ${published} relays`,
    `(cache: ${cache ? "yes" : "NO — control leg"})`
  );
  if (cache) {
    await postJson("/api/db/cache-event", event);
    log("  mirrored into server relay cache via /api/db/cache-event");
  }
  return event;
}

async function findGiftWrap(relays, payeePk, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = await Promise.race([
        pool.querySync(relays, { kinds: [1059], "#p": [payeePk] }),
        sleep(15000).then(() => []),
      ]);
      if (events.length > 0) return events[0];
    } catch {
      /* retry until deadline */
    }
    await sleep(8000);
  }
  return null;
}

function decryptWrap(wrap, recipientSk) {
  const ck = nip44.getConversationKey(recipientSk, wrap.pubkey);
  const seal = JSON.parse(nip44.decrypt(wrap.content, ck));
  const rumor = JSON.parse(nip44.decrypt(seal.content, ck));
  return rumor;
}

// Direct DB read so the fallback leg can PROVE the server cache was empty
// (otherwise background ingestion could silently turn it into a cache hit)
// and that the fallback mirrored the fetched list afterwards.
async function countCachedRelayLists(pubkey) {
  const url = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
  if (!url) return null; // DB not directly reachable — assertion skipped
  const client = new pg.Client(url);
  await client.connect();
  try {
    const res = await client.query(
      "SELECT COUNT(*)::int AS n FROM config_events WHERE pubkey = $1 AND kind = 10002",
      [pubkey]
    );
    return res.rows[0].n;
  } finally {
    await client.end();
  }
}

async function sweepAndWait(escrowId, want) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const sweep = await postJson(
      "/api/cashu/escrow/process",
      {},
      { "x-flow-processor-secret": FLOW_SECRET }
    );
    log(`sweep: ${JSON.stringify(sweep)}`);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(
        `${BASE}/api/cashu/escrow/status?escrowId=${encodeURIComponent(escrowId)}`
      );
      const body = await res.json().catch(() => ({}));
      if (body?.status === want) return body;
      await sleep(4000);
    }
  }
  throw new Error(`escrow ${escrowId.slice(-16)} never reached "${want}"`);
}

// ── Legs ─────────────────────────────────────────────────────────────────────

const AMOUNT = 8;

async function legRelease({ sellerSk, buyerSk, orderId, payeeRelays, expectDelivery }) {
  const sellerPk = getPublicKey(sellerSk);
  const buyerPk = getPublicKey(buyerSk);
  const expiresAt = nowSec() + 3600;
  const { event: commitment, escrowId } = signCommitment({
    buyerSk,
    sellerPk,
    orderId,
    amountSats: AMOUNT,
    expiresAt,
  });
  await postJson("/api/cashu/escrow/register", { commitmentEvent: commitment });
  log(`registered release escrow …${escrowId.slice(-20)}`);

  const wallet = new Wallet(new Mint(MINT));
  await wallet.loadMint();
  const funded = await mintProofs(wallet, AMOUNT * 2);
  const { locked } = await lockForEscrow(
    wallet,
    funded,
    AMOUNT,
    sellerPk,
    buyerPk,
    expiresAt
  );

  await postJson("/api/cashu/escrow/release-approve", {
    actionEvent: signAction(buyerSk, "release", escrowId),
    proofs: toPlainProofs(locked),
  });
  const witnessed = signP2PKProofs(locked, bytesToHex(sellerSk));
  await postJson("/api/cashu/escrow/release", {
    actionEvent: signAction(sellerSk, "release", escrowId),
    payoutProofs: toPlainProofs(witnessed),
  });
  await sweepAndWait(escrowId, "released");
  log("release finalized by payout worker");

  const wrap = await findGiftWrap(payeeRelays, sellerPk, 90000);
  if (!expectDelivery) {
    record(
      `control: cache-miss seller gets NO wrap on own relays (${orderId})`,
      wrap === null,
      wrap ? "unexpected wrap found on non-default relays" : "absent as expected"
    );
    // Degradation proof: the DM must still exist on the default set.
    const onDefaults = await findGiftWrap(DEFAULTS_PLUS_BLAST, sellerPk, 45000);
    let ok = false;
    let detail = "no wrap on defaults either";
    if (onDefaults) {
      const rumor = decryptWrap(onDefaults, sellerSk);
      ok = rumor.kind === 14 && rumor.content.includes(escrowId);
      detail = ok ? "wrap found on defaults only" : "default wrap did not decrypt to this escrow";
    }
    record(`control: cache-miss seller's wrap degraded to defaults (${orderId})`, ok, detail);
    return;
  }

  if (!wrap) {
    record(`release DM on seller's non-default relays (${orderId})`, false, "no wrap within 90s");
    return;
  }
  const rumor = decryptWrap(wrap, sellerSk);
  const subject = rumor.tags?.find((t) => t[0] === "subject")?.[1];
  const ok =
    rumor.kind === 14 &&
    rumor.content.includes(escrowId) &&
    rumor.content.includes("released to you") &&
    subject === "Escrow payout released";
  record(
    `release DM on seller's non-default relays (${orderId})`,
    ok,
    ok ? "wrap found + decrypts to the escrow notice" : `wrap found but content wrong: ${JSON.stringify(rumor).slice(0, 120)}`
  );
}

async function legRefund({ buyerSk, sellerPk, orderId, payeeRelays }) {
  const buyerPk = getPublicKey(buyerSk);
  const expiresAt = nowSec() + 45; // shortest practical lock; refund needs expiry
  const { event: commitment, escrowId } = signCommitment({
    buyerSk,
    sellerPk,
    orderId,
    amountSats: AMOUNT,
    expiresAt,
  });
  await postJson("/api/cashu/escrow/register", { commitmentEvent: commitment });
  log(`registered refund escrow …${escrowId.slice(-20)} (expires in 45s)`);

  const wallet = new Wallet(new Mint(MINT));
  await wallet.loadMint();
  const funded = await mintProofs(wallet, AMOUNT * 2);
  const { locked } = await lockForEscrow(
    wallet,
    funded,
    AMOUNT,
    sellerPk,
    buyerPk,
    expiresAt
  );

  const waitMs = (expiresAt + 2 - nowSec()) * 1000;
  if (waitMs > 0) {
    log(`waiting ${Math.ceil(waitMs / 1000)}s for the lock to expire…`);
    await sleep(waitMs);
  }
  // The library only attaches the buyer's witness AFTER the lock window.
  const witnessed = signP2PKProofs(locked, bytesToHex(buyerSk));
  await postJson("/api/cashu/escrow/refund", {
    actionEvent: signAction(buyerSk, "refund", escrowId),
    payoutProofs: toPlainProofs(witnessed),
  });
  await sweepAndWait(escrowId, "refunded");
  log("refund finalized by payout worker");

  const wrap = await findGiftWrap(payeeRelays, buyerPk, 90000);
  if (!wrap) {
    record(`refund DM on buyer's non-default relays (${orderId})`, false, "no wrap within 90s");
    return;
  }
  const rumor = decryptWrap(wrap, buyerSk);
  const subject = rumor.tags?.find((t) => t[0] === "subject")?.[1];
  const ok =
    rumor.kind === 14 &&
    rumor.content.includes(escrowId) &&
    rumor.content.includes("refunded to you") &&
    subject === "Escrow refund paid";
  record(
    `refund DM on buyer's non-default relays (${orderId})`,
    ok,
    ok ? "wrap found + decrypts to the escrow notice" : `wrap found but content wrong: ${JSON.stringify(rumor).slice(0, 120)}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!FLOW_SECRET) throw new Error("FLOW_PROCESSOR_SECRET is not set");
  const fakeIndexerEvents = [];
  const fakeIndexer = startFakeIndexer(fakeIndexerEvents);
  log(`fake NIP-65 indexer on ws://127.0.0.1:${FAKE_INDEXER_PORT} (server must have NIP65_INDEXER_RELAYS pointed at it)`);

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`dev server not healthy at ${BASE}`);
  const mintInfo = await fetch(`${MINT}/v1/info`).catch(() => null);
  if (!mintInfo?.ok) throw new Error(`staging mint unreachable at ${MINT}`);
  log(`server ${BASE} + mint ${MINT} reachable`);

  const alive = [];
  for (const candidate of NON_DEFAULT_CANDIDATES) {
    if (alive.length >= 2) break;
    if (await probeRelay(candidate)) {
      alive.push(candidate);
      log(`relay up: ${candidate}`);
    } else {
      log(`relay DOWN (skipping): ${candidate}`);
    }
  }
  if (alive.length < 2) {
    throw new Error("need at least 2 reachable non-default relays");
  }
  const payeeRelays = alive.slice(0, 2);

  const sellerSk = generateSecretKey();
  const buyerSk = generateSecretKey();
  const missSellerSk = generateSecretKey();
  const sellerPk = getPublicKey(sellerSk);
  const buyerPk = getPublicKey(buyerSk);

  await publishRelayList(sellerSk, payeeRelays, { cache: true });
  await publishRelayList(buyerSk, payeeRelays, { cache: true });
  const missRelayList = await publishRelayList(missSellerSk, payeeRelays, {
    cache: false,
  });
  // The server's indexer fallback (NIP65_INDEXER_RELAYS override) resolves
  // the cache-missed list from this local relay.
  fakeIndexerEvents.push(missRelayList);
  await sleep(3000); // let the cache write settle before the worker reads it

  const stamp = Date.now().toString(36);
  await legRelease({
    sellerSk,
    buyerSk,
    orderId: `e2e-dm-rel-${stamp}`,
    payeeRelays,
    expectDelivery: true,
  });
  await legRefund({
    buyerSk,
    sellerPk,
    orderId: `e2e-dm-ref-${stamp}`,
    payeeRelays,
  });
  // Fallback leg: prove the server cache really is empty for this payee
  // (else background ingestion could turn it into a cache-hit leg), then
  // prove the fallback's best-effort mirror landed afterwards — together
  // these show the indexer-fetch branch actually executed.
  const missPk = getPublicKey(missSellerSk);
  const cacheBefore = await countCachedRelayLists(missPk);
  if (cacheBefore === null) {
    log("SKIP cache-miss precondition (no DATABASE_URL / NEON_DATABASE_URL)");
  } else {
    record(
      "fallback leg precondition: payee relay list absent from server cache",
      cacheBefore === 0,
      `config_events rows=${cacheBefore}`
    );
  }
  await legRelease({
    sellerSk: missSellerSk,
    buyerSk,
    orderId: `e2e-dm-miss-${stamp}`,
    payeeRelays,
    expectDelivery: true, // cache miss → live NIP-65 indexer fallback
  });
  if (cacheBefore !== null) {
    let cacheAfter = 0;
    for (let i = 0; i < 10 && cacheAfter === 0; i++) {
      await sleep(1000);
      cacheAfter = (await countCachedRelayLists(missPk)) ?? 0;
    }
    record(
      "fallback mirrored the fetched relay list into the server cache",
      cacheAfter >= 1,
      `config_events rows=${cacheAfter}`
    );
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n==== SUMMARY: ${results.length - failed.length}/${results.length} checks passed ====`);
  for (const r of results) log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  pool.close([...DEFAULTS_PLUS_BLAST, ...payeeRelays]);
  fakeIndexer.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL:", error?.message || error);
  process.exit(2);
});
