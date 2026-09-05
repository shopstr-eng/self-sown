/** @jest-environment node */

// sendServerSideNostrDMToRecipientRelays: the escrow payout notification DM
// must reach the PAYEE's own NIP-65 read relays (∪ defaults ∪ blastr), not
// just the default relay set — the same seller-relay delivery fix as order
// DMs. The plain sendServerSideNostrDM keeps its default-relays-only target.

import {
  sendServerSideNostrDM,
  sendServerSideNostrDMToRecipientRelays,
} from "@/utils/nostr/server-nostr-helpers";
import {
  cacheEvent,
  getDbPool,
  fetchRelayConfigFromDb,
} from "@/utils/db/db-service";

const mockPublish = jest.fn();
const mockClose = jest.fn();

jest.mock("nostr-tools/pool", () => ({
  useWebSocketImplementation: jest.fn(),
  SimplePool: jest.fn(() => ({ publish: mockPublish, close: mockClose })),
}));

// Minimal fake relay socket for contained-relay.ts (publishToRelays now uses
// per-relay contained sockets, not SimplePool): records its URL, opens once
// its "open" handler attaches, and ACKs every EVENT frame with OK. The old
// empty-class mock died with "ws.on is not a function".
const mockWsInstances: { url: string; sent: string[] }[] = [];

jest.mock("ws", () => ({
  __esModule: true,
  default: class FakeRelaySocket {
    url: string;
    sent: string[] = [];
    private handlers = new Map<string, ((...args: any[]) => void)[]>();
    constructor(url: string) {
      this.url = url;
      mockWsInstances.push(this);
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      // Fire "open" only after a handler exists (construction precedes
      // handler attachment in publishEventToRelay/queryRelayEvents).
      if (event === "open")
        void Promise.resolve().then(() => this.emit("open"));
      return this;
    }
    private emit(event: string, ...args: any[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args);
    }
    send(data: string) {
      this.sent.push(data);
      try {
        const msg = JSON.parse(data);
        if (msg[0] === "EVENT" && msg[1]?.id) {
          void Promise.resolve().then(() =>
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["OK", msg[1].id, true]))
            )
          );
        } else if (msg[0] === "REQ") {
          void Promise.resolve().then(() =>
            this.emit("message", Buffer.from(JSON.stringify(["EOSE", msg[1]])))
          );
        }
      } catch {
        /* ignore malformed frames */
      }
    }
    close() {}
  },
}));

jest.mock("nostr-tools", () => ({
  finalizeEvent: jest.fn((event: any) => ({
    ...event,
    id: "wrap-1",
    sig: "s".repeat(128),
  })),
  generateSecretKey: jest.fn(() => new Uint8Array(32).fill(1)),
  getPublicKey: jest.fn(() => "c".repeat(64)),
  getEventHash: jest.fn(() => "rumor-1"),
  nip19: {
    decode: jest.fn(() => ({ type: "nsec", data: new Uint8Array(32) })),
  },
  nip44: {
    getConversationKey: jest.fn(() => new Uint8Array(32)),
    encrypt: jest.fn(() => "ciphertext"),
  },
  verifyEvent: jest.fn(() => true),
}));

jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  getDbPool: jest.fn(),
  fetchRelayConfigFromDb: jest.fn(),
}));

// The recipient-relay path DNS-checks every candidate (fail-closed), which
// would drop these fake hostnames; stub the classifier public-safe. The fake
// ws socket never invokes the lookup, so a bare jest.fn() suffices there.
jest.mock("@/utils/url-safety", () => ({
  isSafePublicHostname: jest.fn(async () => true),
  createPublicOnlyLookup: jest.fn(() => jest.fn()),
}));

const mocked = {
  cacheEvent: cacheEvent as jest.Mock,
  getDbPool: getDbPool as jest.Mock,
  fetchRelayConfigFromDb: fetchRelayConfigFromDb as jest.Mock,
};

const RECIPIENT = "d".repeat(64);

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
  "wss://relay.primal.net",
];
const BLASTR_RELAY = "wss://sendit.nosflare.com";

const queryMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENCRYPTION_NSEC = "nsec1test";
  // publishToRelays arms a 21s fallback timeout that loses the race to the
  // resolved publish promise; fake timers keep it from leaking as an open handle.
  jest.useFakeTimers();
  mocked.fetchRelayConfigFromDb.mockResolvedValue([
    {
      kind: 10002,
      tags: [
        ["r", "wss://payee.example"], // unmarked = read+write
        ["r", "wss://payee-read.example", "read"],
        ["r", "wss://payee-write.example", "write"],
      ],
    },
  ]);
  mocked.cacheEvent.mockResolvedValue(undefined);
  queryMock.mockResolvedValue({ rows: [] });
  mocked.getDbPool.mockReturnValue({ query: queryMock });
  mockWsInstances.length = 0;
  // Default: every relay accepts the event (FakeRelaySocket ACKs OK=true).
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.ENCRYPTION_NSEC;
});

describe("sendServerSideNostrDMToRecipientRelays", () => {
  it("publishes to the recipient's NIP-65 read relays + defaults + blastr", async () => {
    const result = await sendServerSideNostrDMToRecipientRelays(
      RECIPIENT,
      "Your escrow payout arrived.",
      "Escrow payout released"
    );

    expect(result).toBe(true);
    expect(mocked.cacheEvent).toHaveBeenCalledTimes(1);
    const relaysPublishedTo = mockWsInstances.map((i) => i.url);
    // Read relays: unmarked (read+write) and read-only are both read targets.
    expect(relaysPublishedTo).toContain("wss://payee.example");
    expect(relaysPublishedTo).toContain("wss://payee-read.example");
    // A write-only relay is NOT a read target.
    expect(relaysPublishedTo).not.toContain("wss://payee-write.example");
    for (const def of DEFAULT_RELAYS) {
      expect(relaysPublishedTo).toContain(def);
    }
    expect(relaysPublishedTo).toContain(BLASTR_RELAY);
    expect(new Set(relaysPublishedTo).size).toBe(relaysPublishedTo.length);
  });

  it("still delivers via defaults + blastr when the recipient has no cached relay list", async () => {
    mocked.fetchRelayConfigFromDb.mockRejectedValue(new Error("db down"));

    const result = await sendServerSideNostrDMToRecipientRelays(
      RECIPIENT,
      "msg",
      "subject"
    );

    expect(result).toBe(true);
    const relaysPublishedTo = mockWsInstances.map((i) => i.url);
    for (const def of DEFAULT_RELAYS) {
      expect(relaysPublishedTo).toContain(def);
    }
    expect(relaysPublishedTo).toContain(BLASTR_RELAY);
  });

  it("returns false without sending when ENCRYPTION_NSEC is not configured", async () => {
    delete process.env.ENCRYPTION_NSEC;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const result = await sendServerSideNostrDMToRecipientRelays(
      RECIPIENT,
      "msg",
      "subject"
    );

    expect(result).toBe(false);
    expect(mockWsInstances).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

describe("sendServerSideNostrDM (unchanged default-relay behavior)", () => {
  it("publishes to default relays only — no recipient relay lookup", async () => {
    const result = await sendServerSideNostrDM(RECIPIENT, "msg", "subject");

    expect(result).toBe(true);
    expect(mocked.fetchRelayConfigFromDb).not.toHaveBeenCalled();
    expect(mockWsInstances.map((i) => i.url)).toEqual(DEFAULT_RELAYS);
  });
});
