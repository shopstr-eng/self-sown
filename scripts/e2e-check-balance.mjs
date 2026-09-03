/** Quick probe: print spendable sats + escrow records from the persisted profile. */
import { createRequire } from "module";
import fs from "node:fs";
const require = createRequire("/tmp/pptr/");
const puppeteer = require("puppeteer-core");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5000";
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

const state = JSON.parse(fs.readFileSync("/tmp/e2e-escrow-state.json", "utf8"));
const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  userDataDir: "/tmp/e2e-profile",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
await page.goto(`${BASE}/wallet`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 8000));
const storage = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});
let total = 0;
try {
  const tokens = JSON.parse(storage.tokens ?? "[]");
  for (const entry of tokens) {
    for (const p of entry.proofs ?? [])
      total += Number(p.amount?.value ?? p.amount ?? 0);
  }
  console.log("token entries:", tokens.length, "spendable sats:", total);
  console.log("token entry mints:", tokens.map((t) => t.mint).join(", "));
} catch (e) {
  console.log(
    "tokens parse failed:",
    String(e),
    (storage.tokens ?? "").slice(0, 200)
  );
}
console.log("cashu_escrows:", (storage.cashu_escrows ?? "none").slice(0, 300));
console.log(
  "balance header:",
  await page.evaluate(() => document.querySelector("h1")?.textContent)
);
console.log("buyerPk matches state:", storage.userPubkey === state.buyerPk);
await browser.close();
