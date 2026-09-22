// One-shot guard for NIP-98 authed assistant requests. NIP-98 proves
// freshness (created_at window) but does not consume event IDs, so a captured
// signed request could be replayed inside that window — for a write-capable
// endpoint, replaying "add a listing" would duplicate the write. The chat and
// setup routes therefore claim each signed event ID once per process.
//
// In-process only: a restart or second instance resets the window, at which
// point the NIP-98 freshness check (~2 minutes) is the remaining bound — the
// same posture as the platform's other NIP-98 endpoints.

import type { NextApiRequest } from "next";

const CLAIM_TTL_MS = 15 * 60 * 1000;
const MAX_CLAIMS = 10_000;

const claims = new Map<string, number>(); // claim key -> expiry (ms epoch)

export function extractNip98EventId(req: NextApiRequest): string | null {
  const authorization = req.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Nostr ")
  ) {
    return null;
  }
  try {
    const event = JSON.parse(
      Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8")
    );
    return typeof event?.id === "string" ? event.id : null;
  } catch {
    return null;
  }
}

export function claimAuthEventOnce(
  pubkey: string,
  eventId: string | null
): boolean {
  if (!eventId) return true; // cannot dedupe — freshness window still applies
  const now = Date.now();
  for (const [key, expiry] of claims) {
    if (expiry <= now) claims.delete(key);
  }
  if (claims.size >= MAX_CLAIMS) claims.clear();
  const claimKey = `${pubkey}:${eventId}`;
  if (claims.has(claimKey)) return false;
  claims.set(claimKey, now + CLAIM_TTL_MS);
  return true;
}
