/** @jest-environment node */

import { republishBlogPostToAuthorRelays } from "@/utils/nostr/server-nostr-helpers";
import {
  cacheEvent,
  getDbPool,
  fetchRelayConfigFromDb,
} from "@/utils/db/db-service";
import { verifyEvent } from "nostr-tools";

const mockPublish = jest.fn();
const mockClose = jest.fn();

jest.mock("nostr-tools/pool", () => ({
  useWebSocketImplementation: jest.fn(),
  SimplePool: jest.fn(() => ({ publish: mockPublish, close: mockClose })),
}));

jest.mock("ws", () => ({ __esModule: true, default: class {} }));

jest.mock("nostr-tools", () => ({
  finalizeEvent: jest.fn(),
  generateSecretKey: jest.fn(),
  getPublicKey: jest.fn(),
  getEventHash: jest.fn(),
  nip19: { decode: jest.fn() },
  nip44: {
    getConversationKey: jest.fn(),
    encrypt: jest.fn(),
  },
  verifyEvent: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  getDbPool: jest.fn(),
  fetchRelayConfigFromDb: jest.fn(),
}));

const mocked = {
  cacheEvent: cacheEvent as jest.Mock,
  getDbPool: getDbPool as jest.Mock,
  fetchRelayConfigFromDb: fetchRelayConfigFromDb as jest.Mock,
  verifyEvent: verifyEvent as unknown as jest.Mock,
};

const AUTHOR = "a".repeat(64);

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
  "wss://relay.primal.net",
];
const BLASTR_RELAY = "wss://sendit.nosflare.com";

function blogEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    pubkey: AUTHOR,
    kind: 30023,
    created_at: 1000,
    content: "body",
    sig: "s".repeat(128),
    tags: [["d", "post-1"]],
    ...overrides,
  } as any;
}

// A NIP-65 (kind 10002) relay-list event with a mix of write/read markers.
function relayListEvents() {
  return [
    {
      kind: 10002,
      tags: [
        ["r", "wss://author.example"], // unmarked = read+write
        ["r", "wss://write.example", "write"], // write-only
        ["r", "wss://read.example", "read"], // read-only -> excluded
      ],
    },
  ];
}

const queryMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // publishToRelays arms a 21s fallback timeout that loses the race to the
  // resolved publish promise; fake timers keep it from leaking as an open handle.
  jest.useFakeTimers();
  mocked.verifyEvent.mockReturnValue(true);
  mocked.fetchRelayConfigFromDb.mockResolvedValue(relayListEvents());
  mocked.cacheEvent.mockResolvedValue(undefined);
  queryMock.mockResolvedValue({ rows: [] });
  mocked.getDbPool.mockReturnValue({ query: queryMock });
  // Default: every relay accepts the event.
  mockPublish.mockImplementation((relays: string[]) =>
    relays.map(() => Promise.resolve("ok"))
  );
});

describe("republishBlogPostToAuthorRelays", () => {
  test("ignores a non-30023 event without touching relays or cache", async () => {
    const result = await republishBlogPostToAuthorRelays(
      blogEvent({ kind: 1 })
    );
    expect(result).toEqual({ published: 0, relays: [] });
    expect(mocked.verifyEvent).not.toHaveBeenCalled();
    expect(mocked.cacheEvent).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test("rejects an event that fails signature verification", async () => {
    mocked.verifyEvent.mockReturnValue(false);
    const result = await republishBlogPostToAuthorRelays(blogEvent());
    expect(result).toEqual({ published: 0, relays: [] });
    expect(mocked.cacheEvent).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test("resolves NIP-65 write relays + defaults + BLASTR, caches, and publishes", async () => {
    const event = blogEvent();
    const result = await republishBlogPostToAuthorRelays(event);

    // Cached before broadcast so the post is readable even if relays time out.
    expect(mocked.cacheEvent).toHaveBeenCalledWith(event);

    const relaysPublishedTo = mockPublish.mock.calls[0]![0] as string[];
    // Author's own write relays (unmarked + write-only) are included.
    expect(relaysPublishedTo).toContain("wss://author.example");
    expect(relaysPublishedTo).toContain("wss://write.example");
    // Read-only relays are NOT a write target.
    expect(relaysPublishedTo).not.toContain("wss://read.example");
    // Defaults + BLASTR fallback are always included.
    for (const def of DEFAULT_RELAYS) {
      expect(relaysPublishedTo).toContain(def);
    }
    expect(relaysPublishedTo).toContain(BLASTR_RELAY);
    // De-duplicated set.
    expect(new Set(relaysPublishedTo).size).toBe(relaysPublishedTo.length);

    expect(result.published).toBe(relaysPublishedTo.length);
    expect(result.relays).toEqual(relaysPublishedTo);
    // No failure tracking when at least one relay accepted.
    expect(queryMock).not.toHaveBeenCalled();
  });

  test("still publishes to defaults + BLASTR when the relay list can't be resolved", async () => {
    mocked.fetchRelayConfigFromDb.mockRejectedValue(new Error("db down"));
    const result = await republishBlogPostToAuthorRelays(blogEvent());
    const relaysPublishedTo = mockPublish.mock.calls[0]![0] as string[];
    for (const def of DEFAULT_RELAYS) {
      expect(relaysPublishedTo).toContain(def);
    }
    expect(relaysPublishedTo).toContain(BLASTR_RELAY);
    expect(result.published).toBeGreaterThan(0);
  });

  test("tracks a failed relay publish when every relay rejects", async () => {
    mockPublish.mockImplementation((relays: string[]) =>
      relays.map(() => Promise.reject(new Error("relay down")))
    );
    const event = blogEvent();
    const result = await republishBlogPostToAuthorRelays(event);

    expect(result.published).toBe(0);
    // Still cached locally so the content isn't lost.
    expect(mocked.cacheEvent).toHaveBeenCalledWith(event);
    // The failed publish is persisted for later retry.
    expect(mocked.getDbPool).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalled();
    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO failed_relay_publishes")
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall![1][0]).toBe(event.id);
  });
});
