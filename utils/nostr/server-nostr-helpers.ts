import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  nip19,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { NostrEvent } from "@/utils/types/types";
import {
  cacheEvent,
  getDbPool,
  fetchRelayConfigFromDb,
} from "@/utils/db/db-service";
import { fetchKind10002FromIndexers } from "@/utils/nostr/nip65-indexer-fetch";
import { publishEventToRelay } from "@/utils/nostr/contained-relay";
import { isSafePublicHostname } from "@/utils/url-safety";

const RELAY_PUBLISH_TIMEOUT_MS = 21000;
const BLASTR_RELAY = "wss://sendit.nosflare.com";

function generateRandomTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDaysAgo = now - 2 * 24 * 60 * 60;
  return Math.floor(Math.random() * (now - twoDaysAgo)) + twoDaysAgo;
}

function getDefaultRelays(): string[] {
  return [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://purplepag.es",
    "wss://relay.primal.net",
  ];
}

async function trackFailedRelayPublish(
  eventId: string,
  event: NostrEvent,
  relays: string[]
): Promise<void> {
  try {
    const dbPool = getDbPool();
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS failed_relay_publishes (
        event_id TEXT PRIMARY KEY,
        event_data TEXT NOT NULL,
        relays TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        retry_count INTEGER DEFAULT 0
      )
    `);
    const values: (string | number)[] = [
      eventId,
      JSON.stringify(event),
      JSON.stringify(relays),
      Math.floor(Date.now() / 1000),
    ];
    await dbPool.query(
      `INSERT INTO failed_relay_publishes (event_id, event_data, relays, created_at, retry_count)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (event_id) DO UPDATE SET
         event_data = EXCLUDED.event_data,
         relays = EXCLUDED.relays,
         created_at = EXCLUDED.created_at`,
      values as any[]
    );
  } catch (error) {
    console.error("Failed to track failed relay publish:", error);
  }
}

export async function publishToRelays(
  event: any,
  relays: string[] = getDefaultRelays(),
  timeoutMs: number = RELAY_PUBLISH_TIMEOUT_MS
): Promise<number> {
  // Per-relay contained sockets: one unreachable relay can neither leak a
  // dangling socket error (observed as uncaughtException with pool.publish
  // when a default relay was down) nor stall the whole publish. Connections
  // are DNS-pinned to vetted public addresses (see contained-relay.ts).
  const results = await Promise.all(
    relays.map((url) => publishEventToRelay(url, event, { timeoutMs }))
  );
  return results.filter(Boolean).length;
}

// NIP-65 relay lists are author-controlled data: a key owner can list ws://
// loopback/private-network URLs or an unbounded endpoint count, and
// server-side delivery would then open WebSocket connections to them. Bound
// delivery targets to a small set of secure, public WebSocket URLs.
const MAX_RECIPIENT_RELAYS = 8;

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  // Literal IPv4: loopback/private/CGNAT/link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Non-dotted IPv4 notations (single-integer/octal/hex tricks like
  // 2130706433 or 0x7f000001, both = 127.0.0.1) are rejected outright.
  if (/^0x[0-9a-f.]+$/i.test(host) || /^[0-9.]+$/.test(host)) {
    return true;
  }
  // Literal IPv6 loopback/ULA/link-local, incl. IPv4-mapped forms.
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    if (
      v6 === "::1" ||
      v6 === "::" ||
      v6.startsWith("fc") ||
      v6.startsWith("fd") ||
      v6.startsWith("fe80") ||
      v6.startsWith("::ffff:")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Keep only secure, public WebSocket relay URLs, deduped and capped. Valid
 * entries pass through byte-identical (callers may rely on exact URLs);
 * invalid ones are dropped, never fatal. Layers: a cheap syntax check for
 * literals/known-bad suffixes, then the shared url-safety DNS classification
 * under a bounded fail-closed deadline (a stuck resolver must not stall the
 * payout path). The actual connection additionally pins DNS to vetted public
 * addresses (contained-relay.ts), closing the rebind-after-check window.
 */
const RELAY_DNS_CHECK_TIMEOUT_MS = 2000;
export async function sanitizeRelayTargetUrls(
  urls: string[],
  isSafePublic: (hostname: string) => Promise<boolean> = isSafePublicHostname
): Promise<string[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (candidates.length >= MAX_RECIPIENT_RELAYS) break;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "wss:") continue;
      if (isPrivateHostname(parsed.hostname)) continue;
      const key = parsed.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(url);
    } catch {
      continue;
    }
  }
  const checked = await Promise.all(
    candidates.map(async (url) => {
      const safe = await Promise.race([
        isSafePublic(new URL(url).hostname),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), RELAY_DNS_CHECK_TIMEOUT_MS)
        ),
      ]);
      return safe ? url : null;
    })
  );
  return checked.filter((u): u is string => u !== null);
}

// Resolve the relays a recipient READS from (NIP-65 kind 10002) from our
// Postgres cache. The orders dashboard subscribes to the seller's own relays,
// so delivering an order gift-wrap there is what makes it show up.
//
// On a cache miss (a payee who has never been active in-app), fall back to a
// live NIP-65 indexer fetch — the same fallback the client order-DM path
// carries — so delivery targets the payee's own relays instead of depending
// on default-relay federation. The fetched list is mirrored into the cache
// best-effort so subsequent sends hit the fast path.
export async function getRecipientReadRelays(
  pubkey: string
): Promise<string[]> {
  try {
    let events = await fetchRelayConfigFromDb(pubkey);
    if (events.length === 0) {
      const fetched = await fetchKind10002FromIndexers(pubkey);
      if (fetched) {
        console.info(
          `[nip65-fallback] cache miss for ${pubkey.slice(0, 8)}… resolved relay list via indexer fetch`
        );
        events = [fetched];
        cacheEvent(fetched).catch(() => {});
      } else {
        console.info(
          `[nip65-fallback] cache miss for ${pubkey.slice(0, 8)}… indexer fetch found nothing, using defaults`
        );
      }
    }
    const out: string[] = [];
    for (const ev of events) {
      for (const tag of ev.tags) {
        // Unmarked ("r", url) = read+write; ("r", url, "read") = read-only.
        if (tag[0] === "r" && tag[1] && (!tag[2] || tag[2] === "read")) {
          out.push(tag[1]);
        }
      }
    }
    return await sanitizeRelayTargetUrls(out);
  } catch (error) {
    console.error("Failed to resolve recipient relays:", error);
    return [];
  }
}

// Republish an already-signed gift-wrap (kind 1059) to its recipient's own
// relays from the server. This is the primary, origin/login-independent
// delivery path: it fixes custom-domain orders where the buyer is a guest and
// the client only published to default/buyer relays the seller never reads.
// The event is self-authenticating (verified below), so no caller auth needed.
export async function republishGiftWrapToRecipientRelays(
  event: NostrEvent
): Promise<{ published: number; relays: string[] }> {
  if (!event || event.kind !== 1059) {
    return { published: 0, relays: [] };
  }
  if (!verifyEvent(event as any)) {
    return { published: 0, relays: [] };
  }
  const recipient = event.tags.find((t) => t[0] === "p")?.[1];
  if (!recipient) {
    return { published: 0, relays: [] };
  }

  const recipientRelays = await getRecipientReadRelays(recipient);
  // Always include defaults + blastr so delivery still happens when the seller
  // has no cached relay list yet.
  const relays = Array.from(
    new Set([...recipientRelays, ...getDefaultRelays(), BLASTR_RELAY])
  );

  // Mirror the event into our cache (idempotent) before broadcasting.
  try {
    await cacheEvent(event);
  } catch (error) {
    console.error("Failed to cache gift-wrap before relay publish:", error);
  }

  const published = await publishToRelays(event, relays);
  if (published === 0) {
    await trackFailedRelayPublish(event.id, event, relays).catch(console.error);
  }
  return { published, relays };
}

// Resolve the relays an author WRITES to (NIP-65 kind 10002) from our Postgres
// cache. Used when the server publishes the author's own pre-signed content
// (e.g. a scheduled blog post) on their behalf.
async function getAuthorWriteRelays(pubkey: string): Promise<string[]> {
  try {
    const events = await fetchRelayConfigFromDb(pubkey);
    const out: string[] = [];
    for (const ev of events) {
      for (const tag of ev.tags) {
        // Unmarked ("r", url) = read+write; ("r", url, "write") = write-only.
        if (tag[0] === "r" && tag[1] && (!tag[2] || tag[2] === "write")) {
          out.push(tag[1]);
        }
      }
    }
    return out;
  } catch (error) {
    console.error("Failed to resolve author write relays:", error);
    return [];
  }
}

// Publish an already-signed kind:30023 blog post (NIP-23) to the author's own
// write relays + defaults from the server. Used by the scheduled-publish cron:
// the seller pre-signed the event client-side, so it is self-authenticating
// (verified below) and needs no server key. The event is mirrored into our
// Postgres cache (idempotent) so the storefront SSR + email broadcast can read
// it immediately. Returns the number of relays that accepted it.
export async function republishBlogPostToAuthorRelays(
  event: NostrEvent
): Promise<{ published: number; relays: string[] }> {
  if (!event || event.kind !== 30023) {
    return { published: 0, relays: [] };
  }
  if (!verifyEvent(event as any)) {
    return { published: 0, relays: [] };
  }

  const authorRelays = await getAuthorWriteRelays(event.pubkey);
  const relays = Array.from(
    new Set([...authorRelays, ...getDefaultRelays(), BLASTR_RELAY])
  );

  // Mirror into our cache (idempotent upsert by id) before broadcasting so the
  // post is readable even if every relay publish times out.
  try {
    await cacheEvent(event);
  } catch (error) {
    console.error("Failed to cache blog post before relay publish:", error);
  }

  const published = await publishToRelays(event, relays);
  if (published === 0) {
    await trackFailedRelayPublish(event.id, event, relays).catch(console.error);
  }
  return { published, relays };
}

// Shared gift-wrap construction + delivery for server-signed DMs (NIP-17).
// `deliverToRecipientRelays` additionally resolves the recipient's own NIP-65
// read relays from the Postgres cache — the same seller-relay delivery fix as
// order DMs: default relays alone miss recipients who read elsewhere.
async function deliverServerSideNostrDM(
  recipientPubkey: string,
  message: string,
  subject: string,
  deliverToRecipientRelays: boolean
): Promise<boolean> {
  try {
    const encryptionNsec = process.env["ENCRYPTION_NSEC"];
    if (!encryptionNsec) {
      console.warn("ENCRYPTION_NSEC not configured, skipping Nostr DM");
      return false;
    }

    const decoded = nip19.decode(encryptionNsec);
    if (decoded.type !== "nsec") {
      console.warn("Invalid ENCRYPTION_NSEC format");
      return false;
    }

    const serverPrivkey = decoded.data as Uint8Array;
    const serverPubkey = getPublicKey(serverPrivkey);
    const defaultRelays = getDefaultRelays();

    const bareEvent = {
      pubkey: serverPubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: message,
      kind: 14,
      tags: [
        ["p", recipientPubkey, defaultRelays[0]!],
        ["subject", subject],
      ],
    };

    const eventToHash: NostrEvent = {
      ...bareEvent,
      id: "",
      sig: "",
    };
    const eventId = getEventHash(eventToHash);
    const messageEvent = { id: eventId, ...bareEvent };

    const randomPrivkey = generateSecretKey();
    const randomPubkey = getPublicKey(randomPrivkey);

    const conversationKey = nip44.getConversationKey(
      randomPrivkey,
      recipientPubkey
    );
    const encryptedRumor = nip44.encrypt(
      JSON.stringify(messageEvent),
      conversationKey
    );

    const sealEvent = {
      pubkey: serverPubkey,
      created_at: generateRandomTimestamp(),
      content: encryptedRumor,
      kind: 13,
      tags: [],
    };
    const signedSeal = finalizeEvent(sealEvent, serverPrivkey);

    const giftWrapConversationKey = nip44.getConversationKey(
      randomPrivkey,
      recipientPubkey
    );
    const encryptedSeal = nip44.encrypt(
      JSON.stringify(signedSeal),
      giftWrapConversationKey
    );
    const giftWrapEvent = {
      pubkey: randomPubkey,
      created_at: generateRandomTimestamp(),
      content: encryptedSeal,
      kind: 1059,
      tags: [["p", recipientPubkey, defaultRelays[0]!]],
    };
    const signedGiftWrap = finalizeEvent(giftWrapEvent, randomPrivkey);

    await cacheEvent(signedGiftWrap as NostrEvent);

    const relays = deliverToRecipientRelays
      ? Array.from(
          new Set([
            ...(await getRecipientReadRelays(recipientPubkey)),
            ...defaultRelays,
            BLASTR_RELAY,
          ])
        )
      : defaultRelays;
    const successCount = await publishToRelays(signedGiftWrap, relays);
    if (successCount === 0) {
      console.warn(
        `Relay publish timed out or failed for gift-wrapped message, but event is saved to database. Recipient: ${recipientPubkey.substring(
          0,
          8
        )}...`
      );
      await trackFailedRelayPublish(
        (signedGiftWrap as NostrEvent).id,
        signedGiftWrap as NostrEvent,
        relays
      ).catch(console.error);
    }

    return true;
  } catch (error) {
    console.error("Failed to send server-side Nostr DM:", error);
    return false;
  }
}

export async function sendServerSideNostrDM(
  recipientPubkey: string,
  message: string,
  subject: string
): Promise<boolean> {
  return deliverServerSideNostrDM(recipientPubkey, message, subject, false);
}

// Same server-signed DM, but delivered to the recipient's OWN NIP-65 read
// relays (∪ defaults ∪ blastr) — use when the recipient may not read the
// default relay set (e.g. escrow payout notifications to sellers on their own
// relays, mirroring the order-DM seller-relay delivery pattern).
export async function sendServerSideNostrDMToRecipientRelays(
  recipientPubkey: string,
  message: string,
  subject: string
): Promise<boolean> {
  return deliverServerSideNostrDM(recipientPubkey, message, subject, true);
}
