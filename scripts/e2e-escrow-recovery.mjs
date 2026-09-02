/**
 * Staging e2e: prove a wiped browser can recover locked escrow funds.
 *
 * Drives the real UI in headless Chromium against the local staging server
 * (escrow flags on, testnut mint). Steps:
 *   A. inject a fresh buyer nsec session + fund the wallet from the test mint
 *   B. escrow checkout on a sats-priced listing (seller opted in)
 *   C. verify kind-7375 backup exists and locked sats are NOT spendable
 *   D. wipe localStorage (keep only sign-in keys), restore via the wallet page
 *   E. after lock expiry, request the refund from the restored record, sweep
 *      the payout worker, redeem the payout, verify balance + pruning
 *
 * Usage: node scripts/e2e-escrow-recovery.mjs [stage]
 *   stage: "all" (default) or one of A,B,C,D,E to stop after that stage.
 */
import { createRequire } from "module";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import { bytesToHex } from "nostr-tools/utils";
import fs from "node:fs";

const require = createRequire("/tmp/pptr/");
const puppeteer = require("puppeteer-core");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5000";
// Local Nutshell mint (FakeWallet, input_fee_ppk=0). testnut.cashu.space
// charges input fees which the two-swap checkout flow can't cover — the
// pre-swap hands sendTokens exactly price+fee, and the escrow lock swap
// would need price+2*fee.
const MINT = process.env.E2E_MINT_URL ?? "http://localhost:3338";
const LISTING_ID =
  process.env.E2E_LISTING_ID ??
  "c56da318edc991280441761424bbe8df524acce1f9b404ae51ba2fd782fe3ec4"; // staging escrow test item, 100 SATS, free shipping
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const SHOTS = "/tmp/e2e-shots";
const STATE = "/tmp/e2e-escrow-state.json";
const PASSPHRASE = "staging-e2e-passphrase";
const FUND_SATS = 30000;

fs.mkdirSync(SHOTS, { recursive: true });

const stageArg = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`shot: ${SHOTS}/${name}.png`);
}

/** Dump visible button/label text to help drive the UI. */
async function dumpUi(page, name) {
  const text = await page.evaluate(() => {
    const els = [...document.querySelectorAll("button, input, [role=button], h1, h2, h3, label, p")];
    return els
      .filter((e) => e.offsetParent !== null)
      .map((e) => `${e.tagName.toLowerCase()}${e.type ? `[${e.type}]` : ""}: ${(e.textContent || e.placeholder || "").trim().slice(0, 80)}`)
      .filter((s) => s.split(": ")[1])
      .join("\n");
  });
  fs.writeFileSync(`${SHOTS}/${name}.txt`, text);
  log(`ui dump: ${SHOTS}/${name}.txt (${text.split("\n").length} els)`);
}

function saveState(patch) {
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  fs.writeFileSync(STATE, JSON.stringify({ ...prev, ...patch }, null, 2));
}
function loadState() {
  return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    // Persistent profile: localStorage carries across stage runs until the
    // wipe stage deliberately clears it (that wipe IS the test).
    userDataDir: "/tmp/e2e-profile",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("console", (m) => {
    const t = m.text();
    if (/error|fail|escrow/i.test(t)) log("console:", t.slice(0, 200));
  });
  page.on("pageerror", (e) => log("pageerror:", String(e).slice(0, 300)));
  return { browser, page };
}

/** Inject a fresh nsec session (with embedded passphrase => no modals). */
async function injectSession(page, keysOnly = false) {
  const state = loadState();
  const buyerSk = state.buyerSk
    ? Uint8Array.from(Buffer.from(state.buyerSk, "hex"))
    : generateSecretKey();
  const buyerPk = getPublicKey(buyerSk);
  const encrypted = nip49.encrypt(buyerSk, PASSPHRASE);
  saveState({ buyerSk: bytesToHex(buyerSk), buyerPk });

  await page.evaluateOnNewDocument(
    (session, keysOnlyFlag) => {
      if (keysOnlyFlag) {
        // Simulated wiped browser: ONLY the sign-in material survives.
        const keep = ["signInMethod", "encryptedPrivateKey", "userPubkey", "userNPub", "signer"];
        for (const k of Object.keys(session)) {
          if (keep.includes(k)) localStorage.setItem(k, session[k]);
        }
        return;
      }
      for (const [k, v] of Object.entries(session)) localStorage.setItem(k, v);
    },
    {
      signInMethod: "nsec",
      encryptedPrivateKey: encrypted,
      userPubkey: buyerPk,
      userNPub: nip19.npubEncode(buyerPk),
      signer: JSON.stringify({
        type: "nsec",
        encryptedPrivKey: encrypted,
        pubkey: buyerPk,
        passphrase: PASSPHRASE,
      }),
      ...(keysOnly
        ? {}
        : {
            mints: JSON.stringify([MINT]),
            migrationComplete: "true",
          }),
    },
    keysOnly
  );
  return { buyerPk };
}

async function getLocalStorage(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  });
}

/** Sum sats currently in the spendable wallet (localStorage `tokens`,
 *  a flat Proof[] per persistReceivedTokens). */
function spendableSats(storage) {
  try {
    const tokens = JSON.parse(storage.tokens ?? "[]");
    let total = 0;
    for (const p of tokens) total += Number(p.amount?.value ?? p.amount ?? 0);
    return total;
  } catch {
    return -1;
  }
}

async function stageA() {
  const { browser, page } = await launch();
  try {
    const { buyerPk } = await injectSession(page);
    log("buyer pubkey:", buyerPk);
    await page.goto(`${BASE}/wallet`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(4000);
    await shot(page, "A1-wallet-fresh");
    await dumpUi(page, "A1-wallet-fresh");
    const storage = await getLocalStorage(page);
    log("logged in as:", storage.userPubkey);
    log("initial spendable sats:", spendableSats(storage));
    saveState({ stage: "A" });
  } finally {
    await browser.close();
  }
}

/** Fund the buyer wallet from the test mint via the app's own Mint modal. */
async function stageFund() {
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/wallet`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);

    const before = spendableSats(await getLocalStorage(page));
    log("spendable before funding:", before);
    if (before >= FUND_SATS) {
      log("already funded, skipping");
      saveState({ fundedSats: before });
      return;
    }

    // Open the Mint modal.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Mint"
      );
      btn?.click();
    });
    await sleep(1500);
    await dumpUi(page, "A2-mint-modal");
    // Fill the sats input and submit.
    await page.evaluate((amount) => {
      const form = [...document.querySelectorAll("form")].find(
        (f) => f.offsetParent !== null
      );
      const input = form?.querySelector("input");
      if (!input) throw new Error("no sats input in mint modal");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, String(amount));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.closest("form")?.requestSubmit();
    }, FUND_SATS - before);
    log("mint submitted, waiting for test mint to auto-pay the invoice...");
    await sleep(4000);
    await shot(page, "A2-invoice");

    // Poll localStorage until proofs land (testnut pays on quote check).
    // The page may navigate when the modal auto-closes — retry through it.
    const deadline = Date.now() + 6 * 60 * 1000;
    let now = before;
    while (Date.now() < deadline) {
      await sleep(5000);
      try {
        now = spendableSats(await getLocalStorage(page));
      } catch {
        continue;
      }
      if (now >= FUND_SATS) break;
    }
    log("spendable after funding:", now);
    await shot(page, "A2-funded");
    if (now < FUND_SATS) throw new Error(`funding stalled at ${now} sats`);
    saveState({ fundedSats: now });
  } finally {
    await browser.close();
  }
}

/** Discovery: open the listing page and dump the purchase UI. */
async function stageDiscover() {
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/listing/${LISTING_ID}`, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
    await sleep(6000);
    await shot(page, "B0-listing");
    await dumpUi(page, "B0-listing");
    log("url after load:", page.url());
  } finally {
    await browser.close();
  }
}

/** Discovery: open the listing, click Buy Now, dump the payment modal. */
async function stageDiscover2() {
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/listing/${LISTING_ID}`, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
    await sleep(5000);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Buy Now")
        ?.click();
    });
    await sleep(5000);
    await shot(page, "B1-payment-modal");
    await dumpUi(page, "B1-payment-modal");
  } finally {
    await browser.close();
  }
}

/** Type into a visible input found by its label text, using real key events
 *  so react-hook-form's Controller state updates. */
async function fillField(page, labelText, value) {
  const tag = `e2e-${labelText.replace(/[^a-z]/gi, "")}`;
  const ok = await page.evaluate(
    (label, tagName) => {
      const lbl = [...document.querySelectorAll("label")].find(
        (l) => l.offsetParent !== null && l.textContent?.trim().startsWith(label)
      );
      if (!lbl) return `no label: ${label}`;
      const container = lbl.closest("div");
      const input =
        (lbl.htmlFor && document.getElementById(lbl.htmlFor)) ||
        container?.querySelector("input, textarea") ||
        lbl.querySelector("input, textarea");
      if (!input) return `no input for: ${label}`;
      input.setAttribute("data-e2e", tagName);
      return true;
    },
    labelText,
    tag
  );
  if (ok !== true) {
    log("fillField warning:", ok);
    return false;
  }
  await page.click(`[data-e2e="${tag}"]`);
  await page.type(`[data-e2e="${tag}"]`, value, { delay: 15 });
  const got = await page.evaluate(
    (tagName) => document.querySelector(`[data-e2e="${tagName}"]`)?.value,
    tag
  );
  log(`filled "${labelText}" =`, got);
  return true;
}

/** Escrow checkout on the listing: form -> escrow toggle -> Pay with Cashu. */
async function stageCheckout() {
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/listing/${LISTING_ID}`, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });
    await sleep(5000);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Buy Now")
        ?.click();
    });
    await sleep(4000);

    await fillField(page, "Name", "Staging Buyer");
    await fillField(page, "Address", "123 Test St");
    await fillField(page, "City", "Seattle");
    await fillField(page, "State/Province", "WA");
    await fillField(page, "Postal code", "98101");
    await fillField(page, "Email for Order Updates", "staging-buyer@example.com");
    // The product's `["required", "Address"]` tag adds an extra required
    // input labeled "Enter Address".
    await fillField(page, "Enter Address", "123 Test St, Seattle WA 98101");
    // Country is a HeroUI select: open and pick "United States of America".
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Select Country" || (b.textContent?.trim() === "Country" && b.offsetParent))
        ?.click();
    });
    let picked = false;
    try {
      await page.waitForSelector("[role='listbox'] [role='option']", { visible: true, timeout: 8000 });
      picked = await page.evaluate(() => {
        const opt = [...document.querySelectorAll("[role='option']")]
          .find((o) => o.textContent?.trim() === "United States of America");
        opt?.click();
        return !!opt;
      });
    } catch {
      log("country listbox never appeared");
    }
    log("country picked:", picked);
    await sleep(800);
    if (!picked) throw new Error("country selection failed");

    // Wait for the escrow toggle (needs shop context + tokens available).
    let escrowFound = false;
    for (let i = 0; i < 20 && !escrowFound; i++) {
      escrowFound = await page.evaluate(() => {
        const cb = [...document.querySelectorAll("input[type='checkbox']")].find(
          (c) =>
            c.offsetParent !== null &&
            c.closest("label")?.textContent?.includes("Pay via escrow")
        );
        if (cb && !cb.checked) cb.click();
        return !!cb;
      });
      if (!escrowFound) await sleep(1500);
    }
    log("escrow toggle found+checked:", escrowFound);
    await shot(page, "B2-form-filled");
    await dumpUi(page, "B2-form-filled");
    if (!escrowFound) throw new Error("escrow toggle never rendered");

    const before = spendableSats(await getLocalStorage(page));
    log("spendable before checkout:", before);

    // Capture everything for post-mortem.
    const errors = [];
    page.on("console", (m) => {
      Promise.all(
        m.args().map((a) =>
          a
            .evaluate((v) => (v instanceof Error ? `${v.message} ${v.stack ?? ""}` : String(v)))
            .catch(() => m.text())
        )
      ).then((parts) => errors.push(`console.${m.type()}: ${parts.join(" | ").slice(0, 500)}`));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
    page.on("requestfailed", (r) => errors.push(`reqfail: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    page.on("response", (r) => {
      if (r.status() >= 400) errors.push(`http${r.status()}: ${r.url().slice(0, 120)}`);
    });
    await page.evaluate(() => {
      window.__e2eErrors = [];
      window.addEventListener("unhandledrejection", (e) =>
        window.__e2eErrors.push("unhandledrejection: " + String(e.reason).slice(0, 300))
      );
      window.addEventListener("error", (e) =>
        window.__e2eErrors.push("window.onerror: " + String(e.message).slice(0, 300))
      );
    });

    // Wait for the Cashu button to become enabled (form validation settled).
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.offsetParent !== null && b.textContent?.includes("Pay with Cashu")
        );
        return btn && !btn.disabled;
      },
      { timeout: 30000 }
    );
    log("Pay with Cashu button is enabled");
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.offsetParent !== null && b.textContent?.includes("Pay with Cashu"))
        ?.click();
    });
    log("clicked Pay with Cashu — waiting for lock + backup...");

    // Success = cashu_escrows record appears in localStorage.
    const deadline = Date.now() + 3 * 60 * 1000;
    let record = null;
    let tick = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      try {
        const storage = await getLocalStorage(page);
        const records = JSON.parse(storage.cashu_escrows ?? "[]");
        if (records.length > 0) {
          record = records[0];
          break;
        }
        if (++tick % 3 === 0) {
          await shot(page, `B3-progress-${tick}`);
          const visible = await page.evaluate(() =>
            document.body.innerText.replace(/\s+/g, " ").slice(0, 400)
          );
          log("still waiting; page says:", visible);
        }
      } catch {
        /* navigation during processing overlay */
      }
    }
    await shot(page, "B3-after-pay");
    await dumpUi(page, "B3-after-pay");
    if (!record) {
      const inPage = await page.evaluate(() => window.__e2eErrors ?? []);
      log("IN-PAGE ERRORS:", JSON.stringify(inPage, null, 2));
      log("PUPPETEER ERRORS:", JSON.stringify(errors.slice(0, 40), null, 2));
      throw new Error("no cashu_escrows record after payment");
    }
    const after = spendableSats(await getLocalStorage(page));
    log("ESCROW RECORD:", JSON.stringify(record, null, 2));
    log("spendable after checkout:", after, "(locked:", record.amountSats, ")");
    saveState({
      escrowId: record.escrowId,
      orderId: record.orderId,
      amountSats: record.amountSats,
      expiresAt: record.expiresAt,
      mintUrl: record.mintUrl,
      lockedToken: record.lockedToken,
      spendableBeforeCheckout: before,
      spendableAfterCheckout: after,
    });
  } finally {
    await browser.close();
  }
}

/** C: after checkout, verify the escrow record + backup + balance exclusion. */
async function stageVerify() {
  const state = loadState();
  if (!state.escrowId) throw new Error("no escrowId in state — run checkout first");
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/wallet`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(6000);
    const storage = await getLocalStorage(page);
    const records = JSON.parse(storage.cashu_escrows ?? "[]");
    const record = records.find((r) => r.escrowId === state.escrowId);
    if (!record) throw new Error("escrow record missing from localStorage");
    if (!record.lockedToken) throw new Error("escrow record has no lockedToken");
    log("escrow record present:", record.escrowId, "locked:", record.amountSats, "sats");

    // Locked proofs must NOT be in the spendable set (secret intersection).
    // Nutshell 0.20 issues v2 short keyset IDs, so decode needs the mint's
    // keyset id list as the second argument.
    const { getDecodedToken } = await import("@cashu/cashu-ts");
    const ks = await (await fetch(`${record.mintUrl}/v1/keysets`)).json();
    const keysetIds = ks.keysets.map((k) => k.id);
    const lockedSecrets = new Set(
      getDecodedToken(record.lockedToken, keysetIds).proofs.map((p) => p.secret)
    );
    const spendable = JSON.parse(storage.tokens ?? "[]");
    const leaked = spendable.filter((p) => lockedSecrets.has(p.secret));
    if (leaked.length > 0)
      throw new Error(`${leaked.length} locked proofs are in the spendable wallet!`);
    log("locked proofs absent from spendable wallet ✓");
    log("spendable now:", spendableSats(storage), "(was", state.spendableBeforeCheckout + ")");
  } finally {
    await browser.close();
  }

  // Verify the kind-7375 escrow backup is on the public relays, encrypted to
  // the buyer, carrying the escrow marker + locked proofs.
  const { SimplePool, nip44 } = await import("nostr-tools");
  const buyerSk = Uint8Array.from(Buffer.from(state.buyerSk, "hex"));
  const pool = new SimplePool();
  const relays = ["wss://relay.damus.io", "wss://nos.lol"];
  const events = await pool.querySync(relays, { kinds: [7375], authors: [state.buyerPk] });
  log("kind-7375 events on relays for buyer:", events.length);
  const convKey = nip44.v2.utils.getConversationKey(buyerSk, state.buyerPk);
  let backupFound = false;
  for (const ev of events) {
    try {
      const plain = nip44.v2.decrypt(ev.content, convKey);
      const payload = JSON.parse(plain);
      if (payload?.escrow?.escrowId === state.escrowId) {
        backupFound = true;
        const lockedSum = (payload.proofs ?? []).reduce((s, p) => s + Number(p.amount), 0);
        log("escrow backup found on relays ✓ locked sats in backup:", lockedSum);
        if (lockedSum !== state.amountSats)
          throw new Error(`backup amount ${lockedSum} != locked ${state.amountSats}`);
      }
    } catch (e) {
      if (String(e).includes("backup amount")) throw e;
      /* other users'/wallet events don't decrypt or don't match */
    }
  }
  pool.close(relays);
  if (!backupFound) throw new Error("no escrow-marked kind-7375 backup found on relays");
}

/** Restore the escrow backup into a wiped-browser wallet page (merge-only,
 * idempotent — click until the relay copy lands in the context). Returns the
 * restored record + storage snapshot, or null. */
async function restoreInWipedContext(page, state) {
  await page.goto(`${BASE}/wallet`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(6000);
  const wiped = await getLocalStorage(page);
  if (wiped.cashu_escrows) throw new Error("wipe failed: cashu_escrows present pre-restore");
  log("wiped browser confirmed: no escrow records, spendable:", spendableSats(wiped));
  await shot(page, "D1-wiped");

  // The restore reads walletContext.proofEvents, which populates
  // asynchronously (DB first, relays later, per-relay timing varies).
  const clickRestore = () =>
    page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.offsetParent !== null && b.textContent?.includes("Restore Wallet From Nostr Backup"))
        ?.click();
    });
  let lastStatus = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await clickRestore();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const statusText = await page.evaluate(
        () =>
          [...document.querySelectorAll("p")].find(
            (p) => p.offsetParent !== null && /Restored|restore|verify/i.test(p.textContent ?? "")
          )?.textContent ?? null
      );
      if (statusText && statusText !== lastStatus) {
        lastStatus = statusText;
        log("restore status:", statusText);
      }
    }
    const storage = await getLocalStorage(page).catch(() => ({}));
    const records = JSON.parse(storage.cashu_escrows ?? "[]");
    const hit = records.find((r) => r.escrowId === state.escrowId);
    if (hit) return { hit, storage };
    await sleep(10000);
  }
  return null;
}

/** D: wipe the browser (fresh context, sign-in keys only) and restore. */
async function stageRestore() {
  const state = loadState();
  if (!state.escrowId) throw new Error("no escrowId in state — run checkout first");
  const { browser } = await launch();
  try {
    // A brand-new browser context = the wiped browser. Only sign-in keys.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (e) => log("pageerror:", String(e).slice(0, 300)));
    await injectSession(page, true); // keysOnly

    log("clicking restore until the relay-fetched backup lands...");
    const restored = await restoreInWipedContext(page, state);
    await shot(page, "D2-restored");
    await dumpUi(page, "D2-restored");
    if (!restored) throw new Error("escrow record did NOT reappear after restore");
    log("escrow record restored ✓ locked token present:", !!restored.hit.lockedToken);

    // Restored locked proofs must never appear as spendable balance.
    const { getDecodedToken } = await import("@cashu/cashu-ts");
    const ks = await (await fetch(`${restored.hit.mintUrl}/v1/keysets`)).json();
    const keysetIds = ks.keysets.map((k) => k.id);
    const lockedSecrets = new Set(
      getDecodedToken(restored.hit.lockedToken, keysetIds).proofs.map((p) => p.secret)
    );
    const spendable = JSON.parse(restored.storage.tokens ?? "[]");
    const leaked = spendable.filter((p) => lockedSecrets.has(p.secret));
    if (leaked.length > 0)
      throw new Error(`${leaked.length} restored locked proofs ARE spendable!`);
    const spendableNow = spendableSats(restored.storage);
    log("restored spendable:", spendableNow, "— locked sats excluded ✓");
    const balanceHeader = await page.evaluate(() => document.querySelector("h1")?.textContent);
    log("wallet balance header:", balanceHeader);
    saveState({ restored: true, restoredSpendable: spendableNow });
    await context.close();
  } finally {
    await browser.close();
  }
}

/** E: after expiry, request the refund from the restored record, sweep, redeem. */
async function stageRefund() {
  const state = loadState();
  if (!state.escrowId) throw new Error("no escrowId in state");
  // Wait for the lock to expire (420s from checkout).
  const waitMs = state.expiresAt * 1000 - Date.now() + 15000;
  if (waitMs > 0) {
    log(`waiting ${Math.round(waitMs / 1000)}s for escrow expiry...`);
    await sleep(waitMs);
  }

  const { browser } = await launch();
  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (e) => log("pageerror:", String(e).slice(0, 300)));
    await injectSession(page, true); // wiped browser, keys only

    // The task requires refunding FROM THE RESTORED record: restore in this
    // wiped context first, then act on it on the orders page.
    log("restoring the wiped browser before refunding...");
    const restored = await restoreInWipedContext(page, state);
    if (!restored) throw new Error("restore failed inside refund stage");
    log("restored in refund context ✓ — proceeding to orders");

    await page.goto(`${BASE}/orders`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(8000);
    await shot(page, "E1-orders");
    await dumpUi(page, "E1-orders");

    // Request the refund from the restored escrow card.
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.offsetParent !== null && /^(Request|Complete) refund$/.test(b.textContent?.trim() ?? "")
      );
      btn?.click();
      return btn?.textContent?.trim() ?? null;
    });
    log("refund button clicked:", clicked);
    if (!clicked) {
      // Already refunded by an earlier run? Then only the redeem step remains.
      const redeemReady = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some(
          (b) => b.offsetParent !== null && b.textContent?.includes("Redeem refund to wallet")
        )
      );
      if (!redeemReady) throw new Error("no refund button on orders page — was the record restored?");
      log("refund already processed — skipping to redeem");
    }

    // Wait for the request to land, then nudge the payout sweep and poll the
    // escrow status endpoint until refunded.
    await sleep(10000);
    await shot(page, "E2-after-request");
    const sweep = await fetch(`${BASE}/api/cashu/escrow/process`, {
      method: "POST",
      headers: { "x-flow-processor-secret": process.env.FLOW_PROCESSOR_SECRET ?? "" },
    });
    log("sweep trigger:", sweep.status, (await sweep.text()).slice(0, 200));

    const deadline = Date.now() + 5 * 60 * 1000;
    let refunded = false;
    while (Date.now() < deadline && !refunded) {
      await sleep(10000);
      const r = await fetch(`${BASE}/api/cashu/escrow/status?escrowId=${state.escrowId}`);
      const body = await r.text();
      log("status poll:", r.status, body.slice(0, 200));
      if (/refunded|payout/i.test(body)) refunded = true;
      if (!refunded) {
        await fetch(`${BASE}/api/cashu/escrow/process`, {
          method: "POST",
          headers: { "x-flow-processor-secret": process.env.FLOW_PROCESSOR_SECRET ?? "" },
        }).catch(() => {});
      }
    }
    if (!refunded) throw new Error("escrow never reached refunded/payout state");

    // Redeem the payout back into the wallet.
    await page.reload({ waitUntil: "networkidle2" });
    await sleep(6000);
    const spendableBeforeRedeem = spendableSats(await getLocalStorage(page));
    const redeemClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.offsetParent !== null && b.textContent?.includes("Redeem refund to wallet")
      );
      btn?.click();
      return !!btn;
    });
    log("redeem button clicked:", redeemClicked);
    if (!redeemClicked) throw new Error("no redeem button after refund");

    const redeemDeadline = Date.now() + 2 * 60 * 1000;
    let spendableAfter = spendableBeforeRedeem;
    while (Date.now() < redeemDeadline) {
      await sleep(5000);
      try {
        const storage = await getLocalStorage(page);
        spendableAfter = spendableSats(storage);
        const records = JSON.parse(storage.cashu_escrows ?? "[]");
        if (spendableAfter > spendableBeforeRedeem && !records.find((r) => r.escrowId === state.escrowId))
          break;
      } catch { /* transient */ }
    }
    await shot(page, "E3-redeemed");
    log("spendable before redeem:", spendableBeforeRedeem, "after:", spendableAfter);
    const finalStorage = await getLocalStorage(page);
    const remaining = JSON.parse(finalStorage.cashu_escrows ?? "[]");
    if (spendableAfter <= spendableBeforeRedeem)
      throw new Error("redeem did not increase spendable balance");
    log("refund redeemed ✓ (+", spendableAfter - spendableBeforeRedeem, "sats); escrow records remaining:", remaining.length);
    saveState({ refunded: true, finalSpendable: spendableAfter });
    await context.close();
  } finally {
    await browser.close();
  }
}

/** Mint-verified spendable total: checks every local proof's Y against the
 * mint (NUT-07 checkstate) and sums only UNSPENT ones. Independent of the
 * wallet's self-heal prune timing. */
async function unspentSatsAtMint(storage, mintUrl) {
  const { hashToCurve } = await import("@cashu/cashu-ts");
  const proofs = JSON.parse(storage.tokens ?? "[]");
  if (!proofs.length) return { total: 0, allUnspent: true, count: 0 };
  const enc = new TextEncoder();
  const Ys = proofs.map((p) => hashToCurve(enc.encode(p.secret)).toHex(true));
  const res = await fetch(`${mintUrl}/v1/checkstate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Ys }),
  });
  if (!res.ok) throw new Error(`checkstate ${res.status}`);
  const body = await res.json();
  const stateByY = new Map(body.states.map((s) => [s.Y, s.state]));
  let total = 0;
  let allUnspent = true;
  proofs.forEach((p, i) => {
    const amount = Number(p.amount?.value ?? p.amount ?? 0);
    if (stateByY.get(Ys[i]) === "UNSPENT") total += amount;
    else allUnspent = false;
  });
  return { total, allUnspent, count: proofs.length };
}

/** F: redeem the completed refund payout into the wallet (default profile
 * holds the same escrow record the wiped browser restored). After the payout
 * the locked proofs are SPENT, so a fresh restore correctly refuses them —
 * redeem uses the record the restored/original browser already holds. */
async function stageRedeem() {
  const state = loadState();
  if (!state.escrowId) throw new Error("no escrowId in state");
  const { browser, page } = await launch();
  try {
    await injectSession(page);
    await page.goto(`${BASE}/orders`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(8000);
    await shot(page, "F1-orders-refunded");
    await dumpUi(page, "F1-orders-refunded");

    let storage = await getLocalStorage(page);
    const hasRecord = JSON.parse(storage.cashu_escrows ?? "[]").find(
      (r) => r.escrowId === state.escrowId
    );

    if (hasRecord) {
      const before = await unspentSatsAtMint(storage, state.mintUrl);
      log("mint-verified unspent before redeem:", before);
      const redeemClicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.offsetParent !== null && b.textContent?.includes("Redeem refund to wallet")
        );
        btn?.click();
        return !!btn;
      });
      log("redeem button clicked:", redeemClicked);
      if (!redeemClicked) throw new Error("no redeem button — is the escrow refunded with a payout token?");

      // Capture any error banner the handler surfaces (e.g. double-redeem).
      await sleep(15000);
      const actionError = await page.evaluate(
        () =>
          [...document.querySelectorAll("p")].find(
            (p) => p.offsetParent !== null && p.className.includes("text-red-700")
          )?.textContent ?? null
      );
      if (actionError) log("redeem error banner:", actionError);

      const deadline = Date.now() + 2 * 60 * 1000;
      let recordGone = false;
      while (Date.now() < deadline) {
        await sleep(5000);
        try {
          storage = await getLocalStorage(page);
          recordGone = !JSON.parse(storage.cashu_escrows ?? "[]").find(
            (r) => r.escrowId === state.escrowId
          );
          if (recordGone) break;
        } catch { /* transient */ }
      }
      if (!recordGone) throw new Error("escrow record not pruned after redeem");
      const after = await unspentSatsAtMint(storage, state.mintUrl);
      log("mint-verified unspent after redeem:", after);
      const gained = after.total - before.total;
      if (gained !== state.amountSats)
        throw new Error(`redeem gained ${gained} sats, expected ${state.amountSats}`);
      log("refund redeemed ✓ +", gained, "sats (mint-verified); record pruned ✓");
      saveState({ refunded: true, finalSpendable: after.total });
    } else {
      // A prior attempt already redeemed (record pruned, payout swapped in).
      // Terminal verification: the payout token's proofs must ALL be SPENT
      // at the mint (the redeem consumed them) and the record must stay gone.
      const status = await (
        await fetch(`${BASE}/api/cashu/escrow/status?escrowId=${encodeURIComponent(state.escrowId)}`)
      ).json();
      if (status.status !== "refunded" || !status.payoutToken)
        throw new Error("escrow not in refunded state with a payout token");
      const { hashToCurve, getDecodedToken } = await import("@cashu/cashu-ts");
      const ks = await (await fetch(`${state.mintUrl}/v1/keysets`)).json();
      const payoutProofs = getDecodedToken(
        status.payoutToken,
        ks.keysets.map((k) => k.id)
      ).proofs;
      const enc = new TextEncoder();
      const Ys = payoutProofs.map((p) => hashToCurve(enc.encode(p.secret)).toHex(true));
      const cs = await (
        await fetch(`${state.mintUrl}/v1/checkstate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ Ys }),
        })
      ).json();
      const states = cs.states.map((s) => s.state);
      log("payout proof states at mint:", states.join(","));
      if (!states.every((s) => s === "SPENT"))
        throw new Error("payout proofs not fully spent — redeem incomplete");
      const now = await unspentSatsAtMint(storage, state.mintUrl);
      log("already redeemed ✓ payout spent at mint; wallet unspent:", now.total);
      saveState({ refunded: true, finalSpendable: now.total });
    }
    await shot(page, "F2-redeemed");
  } finally {
    await browser.close();
  }
}

const stages = { A: stageA, fund: stageFund, discover: stageDiscover, discover2: stageDiscover2, checkout: stageCheckout, verify: stageVerify, restore: stageRestore, refund: stageRefund, redeem: stageRedeem };
async function main() {
  log("base:", BASE, "listing:", LISTING_ID);
  if (stageArg === "all" || stageArg === "A") await stageA();
  if (stageArg === "all" || stageArg === "fund") await stageFund();
  if (stageArg === "discover") await stageDiscover();
  if (stageArg === "discover2") await stageDiscover2();
  if (stageArg === "all" || stageArg === "checkout") await stageCheckout();
  if (stageArg === "all" || stageArg === "verify") await stageVerify();
  if (stageArg === "all" || stageArg === "restore") await stageRestore();
  if (stageArg === "all" || stageArg === "refund") await stageRefund();
  if (stageArg === "redeem") await stageRedeem();
  log("DONE through stage", stageArg);
}
main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
