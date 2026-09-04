/**
 * Server-only minimal relay client for the notification path (order/payout
 * gift wraps, NIP-65 indexer lookups).
 *
 * Why raw sockets instead of nostr-tools SimplePool/Relay:
 * - SimplePool's shared connections outlive the caller — a late socket error
 *   escapes every try/catch as an uncaughtException (observed in staging when
 *   a default relay was unreachable), and querySync waits for EVERY relay's
 *   EOSE, letting one dead relay discard a live one's results.
 * - Per-connection DNS pinning is impossible through the global
 *   useWebSocketImplementation without races between parallel connections.
 *   Here each WebSocket gets the public-only lookup (utils/url-safety), so an
 *   attacker-controlled NIP-65 relay hostname cannot resolve (or rebind) to
 *   private address space: the connection itself uses the vetted address.
 *
 * The protocol surface needed is tiny: REQ → EVENTs → EOSE for queries, and
 * EVENT → OK for publishes. Every session has ONE deadline covering DNS, connect,
 * handshake, and response; error/close handlers attach synchronously, so no
 * socket error can escape.
 */
// @ts-ignore: ws types are not installed; runtime API only
import WebSocket from "ws";
import { createPublicOnlyLookup } from "@/utils/url-safety";
import type { NostrEvent } from "@/utils/types/types";

// Lazy: constructing the lookup at import time breaks any test that mocks
// @/utils/url-safety without knowing about this export (contained-relay is
// pulled in transitively by server-nostr-helpers).
let publicOnlyLookup: ReturnType<typeof createPublicOnlyLookup> | undefined;
function getPublicOnlyLookup() {
  if (!publicOnlyLookup) publicOnlyLookup = createPublicOnlyLookup();
  return publicOnlyLookup;
}

export interface ContainedRelayOptions {
  timeoutMs: number;
  // Only for operator-trusted endpoints (e.g. the NIP65_INDEXER_RELAYS
  // staging override pointing at a local relay). Attacker-influenced targets
  // (NIP-65 r-tags) always go through the pinned public-only lookup.
  allowPrivate?: boolean;
  // Client-side event cap for queries. The Nostr `limit` filter is only a
  // REQUEST — an untrusted relay can stream arbitrarily many/large frames, so
  // the bound is enforced locally (close on reach) to keep the lookup bounded.
  maxEvents?: number;
}

// Generous for relay-list-sized events; NIP-01 relays cap messages around
// 128–256KB. ws also enforces this at the frame layer (error → contained).
const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 5;
// Absolute inbound budgets for the WHOLE session, checked before parsing: a
// hostile relay can otherwise burn the full deadline JSON-parsing unlimited
// junk frames (NOTICEs, wrong-subscription EVENTs) that never count toward
// the accepted-event cap.
const MAX_INBOUND_FRAMES = 64;
const MAX_INBOUND_BYTES = 256 * 1024;

function openSocket(url: string, opts: ContainedRelayOptions): WebSocket {
  const socketOpts: Record<string, unknown> = {
    handshakeTimeout: opts.timeoutMs,
    maxPayload: MAX_FRAME_BYTES,
  };
  if (!opts.allowPrivate) socketOpts.lookup = getPublicOnlyLookup();
  return new WebSocket(url, socketOpts);
}

export async function queryRelayEvents(
  url: string,
  filter: Record<string, unknown>,
  opts: ContainedRelayOptions
): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let settled = false;
    let ws: WebSocket | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* best-effort */
      }
      resolve(events);
    };
    const timer = setTimeout(finish, opts.timeoutMs);
    try {
      ws = openSocket(url, opts);
    } catch {
      finish();
      return;
    }
    const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    const subId = Math.random().toString(36).slice(2, 14);
    let inboundFrames = 0;
    let inboundBytes = 0;
    ws.on("open", () => {
      try {
        ws!.send(JSON.stringify(["REQ", subId, filter]));
      } catch {
        finish();
      }
    });
    ws.on("message", (data: Buffer) => {
      if (settled) return; // session already finished — ignore stragglers
      inboundFrames++;
      inboundBytes += data.length;
      if (
        inboundFrames > MAX_INBOUND_FRAMES ||
        inboundBytes > MAX_INBOUND_BYTES ||
        data.length > MAX_FRAME_BYTES
      ) {
        finish(); // budget exceeded — stop before parsing further frames
        return;
      }
      let msg: unknown[];
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg[0] === "EVENT" && msg[1] === subId && msg[2]) {
        events.push(msg[2] as NostrEvent);
        if (events.length >= maxEvents) {
          try {
            ws!.send(JSON.stringify(["CLOSE", subId]));
          } catch {
            /* best-effort */
          }
          finish();
        }
      } else if (msg[0] === "EOSE" && msg[1] === subId) {
        try {
          ws!.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          /* best-effort */
        }
        finish();
      } else if (msg[0] === "CLOSED" && msg[1] === subId) {
        finish();
      }
    });
    ws.on("error", finish);
    ws.on("close", finish);
  });
}

export async function publishEventToRelay(
  url: string,
  event: { id: string } & Record<string, unknown>,
  opts: ContainedRelayOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | undefined;
    let inboundFrames = 0;
    let inboundBytes = 0;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* best-effort */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), opts.timeoutMs);
    try {
      ws = openSocket(url, opts);
    } catch {
      done(false);
      return;
    }
    ws.on("open", () => {
      try {
        ws!.send(JSON.stringify(["EVENT", event]));
      } catch {
        done(false);
      }
    });
    ws.on("message", (data: Buffer) => {
      if (settled) return;
      inboundFrames++;
      inboundBytes += data.length;
      if (
        inboundFrames > MAX_INBOUND_FRAMES ||
        inboundBytes > MAX_INBOUND_BYTES ||
        data.length > MAX_FRAME_BYTES
      ) {
        done(false); // flooded — fail this relay before parsing further frames
        return;
      }
      let msg: unknown[];
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg[0] === "OK" && msg[1] === event.id) done(msg[2] === true);
    });
    ws.on("error", () => done(false));
    ws.on("close", () => done(false));
  });
}
