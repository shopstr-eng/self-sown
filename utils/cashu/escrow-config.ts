// Configuration gates for Cashu P2PK escrow.
//
// Escrow moves real buyer funds, so every gate here fails CLOSED: unless the
// operator explicitly configures mints, arbiters, and the master switch, the
// escrow endpoints refuse to run and buyers keep using the existing direct
// Cashu checkout. Mirrors the Square config-gate pattern
// (utils/square/square-config.ts).

export const ESCROW_ENABLED_ENV = "CASHU_ESCROW_ENABLED";
export const ESCROW_ALLOWED_MINTS_ENV = "CASHU_ESCROW_ALLOWED_MINTS";
export const ESCROW_ARBITER_PUBKEYS_ENV = "CASHU_ESCROW_ARBITER_PUBKEYS";

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

function normalizeMintUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === "http:") {
    // Plain HTTP is only tolerable against a loopback dev mint; anything
    // else would expose proof exchanges to network interception.
    const host = url.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      return null;
    }
  } else if (url.protocol !== "https:") {
    return null;
  }
  // Strip a trailing slash so "https://mint.example/" and
  // "https://mint.example" are the same configured mint.
  const normalized = url.toString().replace(/\/+$/, "");
  return normalized;
}

export function normalizeEscrowMintUrl(raw: string): string | null {
  return normalizeMintUrl(raw);
}

function parseList(envValue: string | undefined): string[] {
  return (envValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Mints the server will accept escrow proofs from. Empty unless the operator
 * sets CASHU_ESCROW_ALLOWED_MINTS — an empty set must reject everything.
 */
export function getAllowedEscrowMints(
  envValue: string | undefined = process.env[ESCROW_ALLOWED_MINTS_ENV]
): ReadonlySet<string> {
  const mints = new Set<string>();
  for (const entry of parseList(envValue)) {
    const normalized = normalizeMintUrl(entry);
    if (normalized) mints.add(normalized);
  }
  return mints;
}

/**
 * Arbiter pubkeys trusted to co-sign dispute resolutions. Empty unless
 * CASHU_ESCROW_ARBITER_PUBKEYS is set; invalid entries are dropped rather
 * than trusted.
 */
export function getEscrowArbiterPubkeys(
  envValue: string | undefined = process.env[ESCROW_ARBITER_PUBKEYS_ENV]
): ReadonlySet<string> {
  const arbiters = new Set<string>();
  for (const entry of parseList(envValue)) {
    const lowered = entry.toLowerCase();
    if (HEX_PUBKEY_REGEX.test(lowered)) arbiters.add(lowered);
  }
  return arbiters;
}

/** True only when mints AND arbiters are explicitly configured. */
export function isEscrowConfigured(): boolean {
  return (
    getAllowedEscrowMints().size > 0 && getEscrowArbiterPubkeys().size > 0
  );
}

/**
 * Master switch for the escrow API surface. Requires BOTH the explicit
 * enable flag and full configuration; anything less fails closed so a
 * partial deploy can never accept escrow registrations.
 */
export function isEscrowEnabled(): boolean {
  return process.env[ESCROW_ENABLED_ENV] === "true" && isEscrowConfigured();
}

/** Client-side mirror used to scope signer permissions (least privilege). */
export function isEscrowClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED === "true";
}
