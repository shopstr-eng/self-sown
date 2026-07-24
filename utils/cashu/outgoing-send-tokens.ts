const STORAGE_KEY = "milkmarket.outgoingSendTokens";

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
