// Self-host (single-tenant) runtime configuration.
//
// A "Wrangler" (lifetime) seller can run their OWN private copy of Milk Market
// that serves exactly one storefront — their own. When self-host mode is on:
//   - the public marketplace + discovery routes are hidden (see proxy.ts),
//   - the Pro/Herd entitlement is unlocked ONLY for the configured tenant
//     pubkey (see utils/pro/membership.ts), and
//   - card payments use the seller's OWN standard Stripe account via direct
//     charges (no Connect, no platform fees — see the Stripe API routes).
//
// Configuration is read from environment variables first, with an optional
// `milk-market.config.json` file at the repo root as a fallback. Environment
// variables always win so a host can override the committed file per-deploy.
//
// This module is server-only (it imports `fs`/`path`). NEVER import it from a
// client component, the shared pure resolver (utils/pro/membership-status.ts),
// or proxy.ts (edge runtime). The proxy reads the few env vars it needs inline.

import fs from "fs";
import path from "path";
import { nip19 } from "nostr-tools";

export interface SelfHostConfig {
  // Master switch. When false, EVERY helper below behaves as if self-host were
  // entirely absent and the platform runs in its normal multi-tenant mode.
  enabled: boolean;
  // The single owner pubkey (hex, lowercase) this instance belongs to. The
  // entitlement bypass and export endpoint are scoped to exactly this pubkey.
  tenantPubkey: string | null;
  // The owner's storefront slug, used by the proxy to rewrite "/" → the stall.
  tenantSlug: string | null;
  // The owner's preferred Nostr relays / Blossom media servers. Informational +
  // exported in the setup bundle; runtime relay selection lives elsewhere.
  relays: string[];
  blossomServers: string[];
  // Whether this instance should offer card checkout using the seller's OWN
  // standard Stripe account (direct charges). Defaults to true when a
  // STRIPE_SECRET_KEY is present so a configured key "just works".
  ownStripe: boolean;
  // Public repo the seller pulls code updates from (git clone / git pull).
  upstreamRepo: string;
}

// The canonical public repository. Sellers `git pull` from here for updates.
export const DEFAULT_UPSTREAM_REPO =
  "https://github.com/shopstr-eng/milk-market";

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize a pubkey to lowercase hex. Accepts an npub (bech32) or 64-char hex;
// returns null for anything else so a malformed value can never accidentally
// match a real pubkey (the entitlement bypass fails closed).
export function normalizeTenantPubkey(
  value: string | undefined | null
): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(v);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  return null;
}

interface FileConfig {
  pubkey?: string;
  npub?: string;
  slug?: string;
  relays?: unknown;
  blossomServers?: unknown;
  ownStripe?: unknown;
  upstreamRepo?: string;
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
}

// Read the optional milk-market.config.json. Best-effort: a missing or
// malformed file is treated as "no file config" rather than throwing, so a
// typo can never crash the whole app on boot.
function readFileConfig(): FileConfig {
  const candidate =
    process.env.MM_SELF_HOST_CONFIG_PATH?.trim() ||
    path.join(process.cwd(), "milk-market.config.json");
  try {
    if (!fs.existsSync(candidate)) return {};
    const raw = fs.readFileSync(candidate, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as FileConfig;
    return {};
  } catch (err) {
    console.warn(
      "self-host: failed to read milk-market.config.json; ignoring it:",
      err
    );
    return {};
  }
}

// Pure builder: compute the config from explicit env + file inputs. Exposed so
// tests can exercise parsing/precedence without touching process.env or disk.
export function buildSelfHostConfig(
  env: NodeJS.ProcessEnv,
  file: FileConfig = {}
): SelfHostConfig {
  const upstreamRepo =
    env.MM_SELF_HOST_UPSTREAM_REPO?.trim() ||
    (typeof file.upstreamRepo === "string" ? file.upstreamRepo.trim() : "") ||
    DEFAULT_UPSTREAM_REPO;

  if (!truthyEnv(env.MM_SELF_HOST)) {
    return {
      enabled: false,
      tenantPubkey: null,
      tenantSlug: null,
      relays: [],
      blossomServers: [],
      ownStripe: false,
      upstreamRepo,
    };
  }

  const tenantPubkey =
    normalizeTenantPubkey(env.MM_SELF_HOST_PUBKEY) ??
    normalizeTenantPubkey(file.pubkey ?? file.npub ?? null);

  const tenantSlug =
    env.MM_SELF_HOST_SLUG?.trim() ||
    (typeof file.slug === "string" ? file.slug.trim() : "") ||
    null;

  const envRelays = parseList(env.MM_SELF_HOST_RELAYS);
  const relays =
    envRelays.length > 0 ? envRelays : coerceStringList(file.relays);

  const envBlossom = parseList(env.MM_SELF_HOST_BLOSSOM_SERVERS);
  const blossomServers =
    envBlossom.length > 0 ? envBlossom : coerceStringList(file.blossomServers);

  // ownStripe precedence: explicit env override → explicit file flag →
  // auto-on when a Stripe secret key is configured. This lets the card option
  // light up automatically once the seller adds their own key.
  let ownStripe: boolean;
  if (env.MM_SELF_HOST_OWN_STRIPE !== undefined) {
    ownStripe = truthyEnv(env.MM_SELF_HOST_OWN_STRIPE);
  } else if (typeof file.ownStripe === "boolean") {
    ownStripe = file.ownStripe;
  } else {
    ownStripe = !!env.STRIPE_SECRET_KEY;
  }

  return {
    enabled: true,
    tenantPubkey,
    tenantSlug,
    relays,
    blossomServers,
    ownStripe,
    upstreamRepo,
  };
}

let cached: SelfHostConfig | null = null;

// Memoized accessor. Env + file config are fixed for a process lifetime, so we
// resolve once. Use __resetSelfHostConfigCacheForTests() after mutating env in
// a test.
export function getSelfHostConfig(): SelfHostConfig {
  if (cached) return cached;
  cached = buildSelfHostConfig(process.env, readFileConfig());
  return cached;
}

// True when this instance is running as a single-tenant self-host build.
export function isSelfHost(): boolean {
  return getSelfHostConfig().enabled;
}

// True ONLY for the one configured owner pubkey on a self-host instance. This
// is the single gate the entitlement bypass and export endpoint rely on, so it
// fails closed: no tenant pubkey configured ⇒ nobody is the tenant.
export function isSelfHostTenant(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  const cfg = getSelfHostConfig();
  if (!cfg.enabled || !cfg.tenantPubkey) return false;
  return normalizeTenantPubkey(pubkey) === cfg.tenantPubkey;
}

// Test-only: drop the memoized config so the next accessor call re-reads env.
export function __resetSelfHostConfigCacheForTests(): void {
  cached = null;
}
