import {
  SimplePool,
  Filter as NToolFilter,
  Event as NToolEvent,
  EventTemplate as NToolEvenTemplate,
  verifyEvent,
} from "nostr-tools";
import { SubscribeManyParams, SubCloser } from "nostr-tools/abstract-pool";

import { NostrNIP46Signer } from "@/utils/nostr/signers/nostr-nip46-signer";
import {
  ChallengeHandler,
  NostrSigner,
} from "@/utils/nostr/signers/nostr-signer";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import { NostrNIP07Signer } from "@/utils/nostr/signers/nostr-nip07-signer";
import { newPromiseWithTimeout } from "../timeout";

export type NostrRelay = {
  url: string;
  disconnect: () => Promise<void>;
  connect: () => Promise<void>;
  activeSubs: Array<NostrSub>;
  sleeping: boolean;
  lastActive: number;
};

export type NostrSub = {
  _sub: SubCloser;
  close: () => Promise<void>;
};

export type NostrFilter = NToolFilter;
export type NostrEvent = NToolEvent;
export type NostrEventTemplate = NToolEvenTemplate;
export type NostrManagerParams = {
  connectionTimeout?: number;
  keepAliveTime: number;
  gcInterval: number;
  readable?: boolean;
  writable?: boolean;
};

export class NostrManager {
  private readonly pool: SimplePool;
  private readonly params: NostrManagerParams;
  private readonly relays: Array<NostrRelay> = [];
  private gcTimeout: any;

  constructor(relays: Array<string> = [], params?: NostrManagerParams) {
    const {
      keepAliveTime = 1000 * 60 * 5,
      gcInterval = 1000 * 60 * 5,
      connectionTimeout = undefined,
      readable = true,
      writable = true,
    } = params || {};

    this.pool = new SimplePool();
    this.params = {
      keepAliveTime,
      gcInterval,
      connectionTimeout,
      readable,
      writable,
    };
    for (const relay of relays) {
      this.addRelay(relay, { connectionTimeout: connectionTimeout });
    }
    this.gc().catch(console.error);
  }

  public static signerFrom(
    args: { [key: string]: string },
    challengeHandler: ChallengeHandler
  ): NostrSigner {
    const signer =
      NostrNIP07Signer.fromJSON(args, challengeHandler) ??
      NostrNSecSigner.fromJSON(args, challengeHandler) ??
      NostrNIP46Signer.fromJSON(args, challengeHandler);
    if (!signer) throw new Error("Invalid signer type " + JSON.stringify(args));
    return signer;
  }

  private async keepAlive(relays: NostrRelay[]) {
    await Promise.all(
      relays.map(async (relay) => {
        if (relay.sleeping) {
          try {
            await relay.connect();
            relay.sleeping = false;
          } catch (e) {
            console.error(e);
          }
        }
        relay.lastActive = Date.now();
      })
    );
  }

  private async gc() {
    try {
      for (const relay of this.relays) {
        if (
          !relay.sleeping &&
          relay.activeSubs.length === 0 &&
          Date.now() - relay.lastActive > this.params.keepAliveTime
        ) {
          try {
            await relay.disconnect();
          } catch (e) {
            console.error(e);
          }
          relay.sleeping = true;
        }
      }
    } catch (e) {
      console.error(e);
    }
    this.gcTimeout = setTimeout(() => {
      this.gc();
    }, this.params.keepAliveTime);
  }

  public async subscribe(
    filters: NostrFilter[],
    params: SubscribeManyParams,
    relayUrls?: string[]
  ): Promise<NostrSub> {
    if (!this.params.readable) throw new Error("not readable");

    if (params?.onevent) {
      const onevent = params.onevent;
      params.onevent = (event: NostrEvent) => {
        if (verifyEvent(event)) {
          onevent(event);
        }
      };
    }
    if (relayUrls) {
      for (const relayUrl of relayUrls) {
        this.addRelay(relayUrl);
      }
    }

    const relays = relayUrls
      ? this.relays.filter((r) => relayUrls.includes(r.url))
      : this.relays;
    await this.keepAlive(relays);
    const requests = relays.flatMap((r) =>
      filters.map((f) => ({ url: r.url, filter: f }))
    );
    const sub: NostrSub = {
      _sub: this.pool.subscribeMap(requests, params ?? {}),
      close: async () => {
        sub._sub.close();
        for (const relay of relays) {
          const activeSubs = relay.activeSubs;
          const i = activeSubs.indexOf(sub);
          if (i !== -1) activeSubs.splice(i, 1);
        }
      },
    };
    for (const relay of relays) {
      relay.activeSubs.push(sub);
    }
    await this.keepAlive(relays);
    return sub;
  }

  public async fetch(
    filters: NostrFilter[],
    params?: SubscribeManyParams,
    relayUrls?: string[],
    options?: { timeout?: number; resolveOnTimeout?: boolean }
  ): Promise<NostrEvent[]> {
    // Hoisted above the timeout promise so the catch can surface whatever
    // arrived before the timeout instead of discarding it.
    const fetchedEvents: Array<NostrEvent> = [];
    let sub: NostrSub | undefined;
    let didCloseSub = false;

    const closeSubIfNeeded = async () => {
      if (!sub || didCloseSub) return;
      didCloseSub = true;
      await sub.close();
    };

    try {
      return await newPromiseWithTimeout<NostrEvent[]>(
        async (resolve, _reject, abortSignal) => {
          if (!params) {
            params = {};
          }

          if (!params.onevent) {
            params.onevent = () => {};
          }

          if (!params.oneose) {
            params.oneose = () => {};
          }

          const onEvent = params.onevent;
          const onEose = params.oneose;
          let didResolve = false;

          params.onevent = (event: NostrEvent) => {
            fetchedEvents.push(event);
            return onEvent!(event);
          };

          params.oneose = () => {
            closeSubIfNeeded().catch(console.error);
            if (!didResolve) {
              didResolve = true;
              resolve(fetchedEvents);
            }
            return onEose!();
          };

          sub = await this.subscribe(filters, params, relayUrls);
          // If the timeout already fired while we were establishing the
          // subscription, close it immediately so a late-resolving subscribe
          // can't leak a live sub after the promise has settled.
          if (abortSignal.aborted) {
            closeSubIfNeeded().catch(console.error);
          }
        },
        options?.timeout ? { timeout: options.timeout } : undefined
      );
    } catch (err) {
      // nostr-tools only fires `oneose` after EVERY relay in the request set
      // has sent EOSE, so a single connected-but-silent relay (common on a cold
      // pool — e.g. a storefront's first visit before the marketplace warms the
      // connections) blocks it until the timeout fires and rejects. Default
      // behavior still rejects (callers may want to fall back to a cache), but
      // when `resolveOnTimeout` is set we surface the events that DID arrive on
      // the responsive relays instead of throwing them away — otherwise a feed
      // looks empty even though the posts exist. Only the timeout is swallowed;
      // genuine subscribe failures (e.g. "not readable") still propagate.
      await closeSubIfNeeded().catch(() => {});
      const isTimeout = err instanceof Error && err.message === "Timeout";
      if (options?.resolveOnTimeout && isTimeout) {
        return fetchedEvents;
      }
      throw err;
    }
  }

  public async publish(event: NostrEvent, relayUrls?: string[]): Promise<void> {
    if (!this.params.writable) throw new Error("not writable");
    if (relayUrls) {
      for (const relayUrl of relayUrls) {
        this.addRelay(relayUrl);
      }
    }

    const relays = relayUrls
      ? this.relays.filter((r) => relayUrls.includes(r.url))
      : this.relays;
    await this.keepAlive(relays);
    await Promise.allSettled(
      this.pool.publish(
        relays.map((r) => r.url),
        event
      )
    );
  }

  public addRelay(
    relayUrl: string,
    params?: {
      connectionTimeout?: number;
    }
  ): void {
    if (this.relays.find((r) => r.url === relayUrl)) return;
    const r = this.pool.ensureRelay(relayUrl, params);
    const relay: NostrRelay = {
      url: relayUrl,
      connect: async () => {
        this.pool.ensureRelay(relayUrl, params);
        await (await r).connect();
      },
      disconnect: async () => {
        (await r).close();
      },
      activeSubs: [],
      sleeping: true,
      lastActive: Date.now(),
    };
    this.relays.push(relay);
  }

  public addRelays(
    relayUrls: string[],
    params?: {
      connectionTimeout?: number;
    }
  ): void {
    for (const relayUrl of relayUrls) {
      this.addRelay(relayUrl, params);
    }
  }

  public close() {
    clearTimeout(this.gcTimeout);
    for (const relay of this.relays) {
      for (const sub of [...relay.activeSubs]) {
        sub.close();
      }
      relay.disconnect();
    }
    this.relays.length = 0;
  }
}
