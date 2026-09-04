/**
 * Live NIP-65 (kind 10002) lookup for pubkeys whose relay list is missing
 * from the Postgres cache. Server-side delivery paths (order/payout gift
 * wraps) fall back to this so a payee's own read relays are still targeted
 * instead of relying on default-relay/blastr federation luck — federation
 * masked cache misses in staging but is not a delivery guarantee (a payee on
 * a small or private relay would silently miss the DM).
 *
 * Each indexer is queried through its own contained socket (see
 * contained-relay.ts): one slow/unreachable indexer can neither discard a
 * reachable indexer's results nor leak a dangling socket error.
 */
import { verifyEvent } from "nostr-tools";
import type { NostrEvent } from "@/utils/types/types";
import { queryRelayEvents } from "@/utils/nostr/contained-relay";

// Well-known NIP-65 indexers. Both are already in the default publish set,
// so any kind:10002 the app published is held by at least one of them.
// Operator-overridable (comma-separated) — used by the staging e2e to point
// at a local relay, and available to self-hosters running their own indexer.
const DEFAULT_NIP65_INDEXER_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.nostr.band",
];
function getIndexerRelays(): { urls: string[]; operatorConfigured: boolean } {
  const fromEnv = (process.env.NIP65_INDEXER_RELAYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Only an explicit operator override is trusted with private/local
  // endpoints (staging e2e); built-in defaults use the pinned public lookup.
  return fromEnv.length > 0
    ? { urls: fromEnv, operatorConfigured: true }
    : { urls: DEFAULT_NIP65_INDEXER_RELAYS, operatorConfigured: false };
}

// Bounded: this sits on the payout/order notification path, which must not
// stall on slow indexers. A miss degrades to the pre-existing default set.
// The deadline covers DNS + connect + query.
const INDEXER_FETCH_TIMEOUT_MS = 5000;

export async function fetchKind10002FromIndexers(
  pubkey: string,
  timeoutMs: number = INDEXER_FETCH_TIMEOUT_MS
): Promise<NostrEvent | null> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  const { urls, operatorConfigured } = getIndexerRelays();
  const batches = await Promise.all(
    urls.map((url) =>
      queryRelayEvents(
        url,
        { kinds: [10002], authors: [pubkey], limit: 5 },
        { timeoutMs, allowPrivate: operatorConfigured }
      )
    )
  );
  const events = batches.flat();
  if (events.length === 0) return null;
  // Relay data is untrusted: only a kind-10002 event with a valid signature
  // by the claimed author is usable (or cacheable). Replaceable — newest wins.
  const verified = events.filter(
    (ev) => ev.kind === 10002 && ev.pubkey === pubkey && verifyEvent(ev as any)
  );
  if (verified.length === 0) return null;
  verified.sort((a, b) => b.created_at - a.created_at);
  return verified[0] as NostrEvent;
}
