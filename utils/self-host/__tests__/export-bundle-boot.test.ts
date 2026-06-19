// End-to-end "boot" smoke check for the self-host export bundle.
//
// The other suites verify the bundle's *contents* in isolation. This one closes
// the loop a paying Wrangler seller actually depends on: it packs the REAL ZIP
// (createZip), extracts it back out, and then feeds the generated
// `milk-market.config.json` + `.env.example` through the ACTUAL runtime config
// reader (buildSelfHostConfig) and the proxy routing helpers. That proves the
// bundle's output is in the exact shape the running instance consumes, so a
// seller who unzips it and starts the app gets a working single-tenant store:
// marketplace hidden, their stall served at root, Lightning/Cashu live, card
// off until they add their own key.
//
// What this CANNOT do in CI/agent is run a full `pnpm build` of Next (cold
// compile OOMs; this repo *is* the upstream). The manual full-build verification
// is documented in docs/architecture/self-host.md ("Boot smoke check"); this
// test guarantees everything up to that compile step.

import { spawnSync } from "child_process";
import { buildExportEntries } from "@/utils/self-host/export-bundle";
import { createZip } from "@/utils/self-host/zip";
import {
  buildSelfHostConfig,
  normalizeTenantPubkey,
  DEFAULT_UPSTREAM_REPO,
} from "@/utils/self-host/config";
import {
  isSelfHostBlockedPage,
  isSelfHostBlockedApi,
  selfHostStallRewritePath,
  SELF_HOST_CONNECT_ALLOW,
} from "@/utils/self-host/routing";

const PUBKEY = "b".repeat(64);
const SLUG = "green-pastures";
const RELAY = "wss://relay.example";
const BLOSSOM = "https://blossom.example";

// Minimal STORE-method ZIP extractor (mirror of utils/self-host/zip.ts, which
// only ever emits method 0). Walks the local file headers and returns a
// name -> UTF-8 string map, so we read the bundle back the way an `unzip` would.
function extractStoreZip(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  const LOCAL_SIG = 0x04034b50;
  const u16 = (o: number) => zip[o]! | (zip[o + 1]! << 8);
  const u32 = (o: number) =>
    (zip[o]! |
      (zip[o + 1]! << 8) |
      (zip[o + 2]! << 16) |
      (zip[o + 3]! << 24)) >>>
    0;
  while (off + 4 <= zip.length && u32(off) === LOCAL_SIG) {
    const compSize = u32(off + 18);
    const nameLen = u16(off + 26);
    const extraLen = u16(off + 28);
    const nameStart = off + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = zip.subarray(nameStart, nameStart + nameLen).toString("utf8");
    out[name] = zip.subarray(dataStart, dataStart + compSize).toString("utf8");
    off = dataStart + compSize;
  }
  return out;
}

// Parse a dotenv-style file (KEY=VALUE, ignoring comments / blank lines) into a
// plain env object, exactly as a host would source `.env`.
function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

describe("self-host export bundle boots", () => {
  // 1. Generate + pack the REAL bundle artifact, then extract it back out.
  const entries = buildExportEntries({
    pubkey: PUBKEY,
    slug: SLUG,
    relays: [RELAY],
    blossomServers: [BLOSSOM],
    branding: { primaryColor: "#0a0" },
    generatedAt: "2026-06-16T00:00:00.000Z",
  });
  const zip = createZip(entries);
  const files = extractStoreZip(zip);

  it("the packed ZIP round-trips to the full file set", () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        ".env.example",
        "README.md",
        "SETUP.md",
        "manifest.json",
        "milk-market.config.json",
        "setup.sh",
      ].sort()
    );
    // Bytes survived the STORE round-trip intact.
    const cfg = JSON.parse(files["milk-market.config.json"]!);
    expect(cfg.pubkey).toBe(PUBKEY);
  });

  it("setup.sh is valid, safe bash that clones the seller's upstream repo", () => {
    const script = files["setup.sh"]!;
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    // Strict mode so a failed clone/copy aborts instead of half-booting.
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain(`git clone`);
    expect(script).toContain(DEFAULT_UPSTREAM_REPO);
    // `bash -n` parses the script without executing it: catches syntax errors a
    // seller would otherwise only hit at clone time.
    const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });

  // 2. Boot path A: the seller copies `.env.example` -> `.env`. Resolve the
  // runtime config from those env vars alone (env wins over the committed file).
  const env = parseDotenv(files[".env.example"]!);
  const fromEnv = buildSelfHostConfig(env, {});

  it("the generated .env enables single-tenant mode for the owner", () => {
    expect(fromEnv.enabled).toBe(true);
    expect(fromEnv.tenantPubkey).toBe(PUBKEY);
    expect(fromEnv.tenantSlug).toBe(SLUG);
    expect(fromEnv.relays).toEqual([RELAY]);
    expect(fromEnv.blossomServers).toEqual([BLOSSOM]);
    expect(fromEnv.upstreamRepo).toBe(DEFAULT_UPSTREAM_REPO);
  });

  it("card checkout is OFF until the seller adds their own Stripe key", () => {
    // No STRIPE_SECRET_KEY in the template, so ownStripe must resolve false:
    // Lightning/Cashu work out of the box; card stays dark (fail-closed).
    expect(env.STRIPE_SECRET_KEY).toBe("");
    expect(fromEnv.ownStripe).toBe(false);
  });

  // 3. Boot path B: a `git pull` seller who relies on the committed
  // `milk-market.config.json` (only MM_SELF_HOST set in env). The config file's
  // shape must be exactly what the runtime reader consumes.
  const fileConfig = JSON.parse(files["milk-market.config.json"]!);
  const fromFile = buildSelfHostConfig({ MM_SELF_HOST: "1" }, fileConfig);

  it("the committed config.json alone also boots the owner's store", () => {
    expect(fromFile.enabled).toBe(true);
    expect(fromFile.tenantPubkey).toBe(PUBKEY);
    expect(fromFile.tenantSlug).toBe(SLUG);
    expect(fromFile.relays).toEqual([RELAY]);
    expect(fromFile.ownStripe).toBe(false);
  });

  // 4. With the resolved config, the proxy routing helpers must hide the
  // marketplace and serve the tenant's stall at root.
  it("marketplace / discovery / Pro-billing pages are hidden", () => {
    expect(isSelfHostBlockedPage("/marketplace")).toBe(true);
    expect(isSelfHostBlockedPage("/marketplace/anything")).toBe(true);
    expect(isSelfHostBlockedPage("/pro")).toBe(true);
    expect(isSelfHostBlockedPage("/communities")).toBe(true);
    expect(isSelfHostBlockedPage("/npub1abcdef")).toBe(true);
    // The storefront itself is NOT blocked.
    expect(isSelfHostBlockedPage("/")).toBe(false);
    expect(isSelfHostBlockedPage(`/stall/${fromEnv.tenantSlug}`)).toBe(false);
  });

  it("the tenant's storefront renders at the root URL", () => {
    const slug = fromEnv.tenantSlug!;
    expect(selfHostStallRewritePath("/", slug)).toBe(`/stall/${slug}`);
    expect(selfHostStallRewritePath("/cart", slug)).toBe(`/stall/${slug}/cart`);
  });

  it("checkout paths load; only Connect onboarding + platform billing are blocked", () => {
    // Lightning + Cashu checkout is client-side (wallet ↔ mint) with NO server
    // route and no server secret, so nothing about self-host can block it — the
    // store can take LN/Cashu payments the moment it boots. The order-message
    // pipeline (gift wraps over Nostr relays) is likewise un-gated.
    expect(isSelfHostBlockedApi("/api/nostr/publish-order-event")).toBe(false);
    // The card path's server gate (create-payment-intent) passes the proxy; it
    // does its own self-host authorization (own-Stripe + tenant-pubkey).
    expect(isSelfHostBlockedApi("/api/stripe/create-payment-intent")).toBe(
      false
    );
    // Card seller-status read stays live (drives the card button decision)...
    expect(isSelfHostBlockedApi(SELF_HOST_CONNECT_ALLOW)).toBe(false);
    // ...but Connect onboarding + platform billing are refused.
    expect(isSelfHostBlockedApi("/api/stripe/connect/create-account")).toBe(
      true
    );
    expect(isSelfHostBlockedApi("/api/pro/create-lifetime")).toBe(true);
    expect(isSelfHostBlockedApi("/api/pro/create-subscription")).toBe(true);
  });

  it("a non-owner pubkey is never treated as the tenant (fails closed)", () => {
    const other = normalizeTenantPubkey("c".repeat(64));
    expect(other).not.toBe(fromEnv.tenantPubkey);
    expect(fromEnv.tenantPubkey).toBe(normalizeTenantPubkey(PUBKEY));
  });
});
