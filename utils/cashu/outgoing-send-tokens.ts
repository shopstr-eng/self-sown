const STORAGE_KEY = "selfsown.outgoingSendTokens";
// Pre-rename key. Migrated lazily on first read so users never lose track of
// an unclaimed (potentially live-money) token.
const LEGACY_STORAGE_KEY = "milkmarket.outgoingSendTokens";

function migrateLegacyKey(): void {
  if (typeof window === "undefined") return;
  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw === null) return;
    const currentRaw = window.localStorage.getItem(STORAGE_KEY);
    if (currentRaw === null) {
      window.localStorage.setItem(STORAGE_KEY, legacyRaw);
    } else {
      // An old tab can still write to the legacy key after a new tab created
      // selfsown.* — merge (deduped by token) instead of dropping it, and
      // only remove the legacy key once the union is durably written.
      try {
        const legacy = JSON.parse(legacyRaw);
        const current = JSON.parse(currentRaw);
        if (Array.isArray(legacy) && Array.isArray(current)) {
          const seen = new Set(current.map((t: OutgoingSendToken) => t?.token));
          const merged = [
            ...current,
            ...legacy.filter((t: OutgoingSendToken) => t && !seen.has(t.token)),
          ];
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } else return;
      } catch {
        return; // unparseable — keep the legacy key so nothing is lost
      }
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // best-effort migration; a blocked storage API must not break reads
  }
}

export type OutgoingSendTokenStatus = "unclaimed" | "claimed" | "reclaimed";

export interface OutgoingSendToken {
  token: string;
  mintUrl: string;
  amount: number;
  createdAt: number;
  status: OutgoingSendTokenStatus;
  resolvedAt?: number;
}

/**
 * Resolved (claimed/reclaimed) entries are kept for this long so the user can
 * still see what happened, then pruned. Unclaimed entries are NEVER pruned —
 * an unclaimed token is potentially live money.
 */
export const RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function readAll(): OutgoingSendToken[] {
  if (typeof window === "undefined") return [];
  migrateLegacyKey();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: OutgoingSendToken[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  // Same-tab listeners (wallet page) don't get native storage events for our
  // own writes — mirror the wallet-mint-sync pattern of a synthetic event.
  try {
    window.dispatchEvent(new Event("storage"));
  } catch {
    /* ignore */
  }
}

function prune(entries: OutgoingSendToken[]): OutgoingSendToken[] {
  const cutoff = Date.now() - RESOLVED_RETENTION_MS;
  return entries.filter(
    (e) => e.status === "unclaimed" || (e.resolvedAt ?? e.createdAt) >= cutoff
  );
}

/** Newest first. */
export function getOutgoingSendTokens(): OutgoingSendToken[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export interface RecordOutgoingSendTokenInput {
  token: string;
  mintUrl: string;
  amount: number;
}

/**
 * Durably record a freshly-generated send token. Must be called BEFORE the
 * token is displayed to the user, so closing the tab can never lose it.
 * Upserts by token string. Throws on storage failure — callers treat that as
 * a failed send (the swap-recovery path re-stashes the proofs).
 */
export function recordOutgoingSendToken(
  input: RecordOutgoingSendTokenInput
): OutgoingSendToken {
  const entries = prune(readAll());
  const existingIdx = entries.findIndex((e) => e.token === input.token);
  const next: OutgoingSendToken = {
    token: input.token,
    mintUrl: input.mintUrl,
    amount: input.amount,
    createdAt: existingIdx >= 0 ? entries[existingIdx]!.createdAt : Date.now(),
    status: existingIdx >= 0 ? entries[existingIdx]!.status : "unclaimed",
  };
  if (existingIdx >= 0) {
    entries[existingIdx] = next;
  } else {
    entries.push(next);
  }
  writeAll(entries);
  return next;
}

/** Mark a token as redeemed by the recipient (claimed) or taken back (reclaimed). */
export function resolveOutgoingSendToken(
  token: string,
  status: "claimed" | "reclaimed"
): void {
  const entries = readAll();
  const idx = entries.findIndex((e) => e.token === token);
  if (idx < 0) return;
  entries[idx] = { ...entries[idx]!, status, resolvedAt: Date.now() };
  writeAll(prune(entries));
}
