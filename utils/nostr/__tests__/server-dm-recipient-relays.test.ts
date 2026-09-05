/**
 * getRecipientReadRelays: the Postgres relay cache is the fast path; a cache
 * miss falls back to a live NIP-65 indexer fetch (and mirrors the result back
 * into the cache) so payout/order DMs still target the payee's own relays
 * instead of depending on default-relay federation.
 */
import { getRecipientReadRelays } from "@/utils/nostr/server-nostr-helpers";
import { fetchRelayConfigFromDb, cacheEvent } from "@/utils/db/db-service";
import { fetchKind10002FromIndexers } from "@/utils/nostr/nip65-indexer-fetch";

jest.mock("@/utils/db/db-service", () => ({
  fetchRelayConfigFromDb: jest.fn(),
  cacheEvent: jest.fn().mockResolvedValue(undefined),
  getDbPool: jest.fn(),
}));
jest.mock("@/utils/nostr/nip65-indexer-fetch", () => ({
  fetchKind10002FromIndexers: jest.fn(),
}));
// Deterministic DNS layer: hosts tagged "private-dns" simulate a public
// hostname that resolves to private space; "stuck-dns" simulates a resolver
// that never answers; everything else is public.
jest.mock("@/utils/url-safety", () => ({
  isSafePublicHostname: jest.fn((hostname: string) =>
    hostname.includes("stuck-dns")
      ? new Promise<boolean>(() => {})
      : Promise.resolve(!hostname.includes("private-dns"))
  ),
  // contained-relay builds one at module scope; the DNS pin itself is tested
  // in contained-relay.test.ts against the real implementation.
  createPublicOnlyLookup: jest.fn(() => jest.fn()),
}));

const fetchDbMock = fetchRelayConfigFromDb as jest.Mock;
const cacheEventMock = cacheEvent as jest.Mock;
const indexerMock = fetchKind10002FromIndexers as jest.Mock;

const PAYEE = "a".repeat(64);
const relayEvent = (tags: string[][]) =>
  ({
    id: "b".repeat(64),
    pubkey: PAYEE,
    kind: 10002,
    created_at: 1700000000,
    content: "",
    tags,
    sig: "c".repeat(128),
  }) as any;

describe("getRecipientReadRelays", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses the cached list when present and never hits the indexers", async () => {
    fetchDbMock.mockResolvedValue([
      relayEvent([
        ["r", "wss://nostr.mom"],
        ["r", "wss://read.example", "read"],
        ["r", "wss://write-only.example", "write"],
      ]),
    ]);
    const relays = await getRecipientReadRelays(PAYEE);
    expect(relays).toEqual(["wss://nostr.mom", "wss://read.example"]);
    expect(indexerMock).not.toHaveBeenCalled();
    expect(cacheEventMock).not.toHaveBeenCalled();
  });

  it("falls back to a live indexer fetch on a cache miss and mirrors it into the cache", async () => {
    fetchDbMock.mockResolvedValue([]);
    const fetched = relayEvent([
      ["r", "wss://offchain.pub"],
      ["r", "wss://write-only.example", "write"],
    ]);
    indexerMock.mockResolvedValue(fetched);
    const relays = await getRecipientReadRelays(PAYEE);
    expect(relays).toEqual(["wss://offchain.pub"]);
    expect(cacheEventMock).toHaveBeenCalledWith(fetched);
  });

  it("returns [] when neither the cache nor the indexers have a list", async () => {
    fetchDbMock.mockResolvedValue([]);
    indexerMock.mockResolvedValue(null);
    const relays = await getRecipientReadRelays(PAYEE);
    expect(relays).toEqual([]);
    expect(cacheEventMock).not.toHaveBeenCalled();
  });

  it("still resolves to [] (never throws) when the indexer fetch rejects", async () => {
    fetchDbMock.mockResolvedValue([]);
    indexerMock.mockRejectedValue(new Error("indexers down"));
    // The fallback is awaited inside a try/catch — a rejection must degrade
    // to the default relay set, never break the payout path.
    await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([]);
  });

  it("preserves the existing fail-closed behavior when the DB read throws", async () => {
    fetchDbMock.mockRejectedValue(new Error("db down"));
    await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([]);
    expect(indexerMock).not.toHaveBeenCalled();
  });

  describe("relay-target safety (author-controlled data)", () => {
    it("drops non-wss and private-network targets from cached lists", async () => {
      fetchDbMock.mockResolvedValue([
        relayEvent([
          ["r", "ws://nostr.mom"], // insecure scheme
          ["r", "wss://127.0.0.1:7777"],
          ["r", "wss://10.0.0.4"],
          ["r", "wss://[::1]"],
          ["r", "wss://relay.localhost"],
          ["r", "wss://relay.internal"],
          ["r", "wss://2130706433"], // integer IPv4 = 127.0.0.1
          ["r", "wss://0x7f000001"], // hex IPv4 = 127.0.0.1
          ["r", "wss://nostr.mom"],
        ]),
      ]);
      await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([
        "wss://nostr.mom",
      ]);
    });

    it("drops the same unsafe targets from indexer-fetched lists", async () => {
      fetchDbMock.mockResolvedValue([]);
      indexerMock.mockResolvedValue(
        relayEvent([
          ["r", "wss://192.168.1.1"],
          ["r", "wss://offchain.pub"],
        ])
      );
      await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([
        "wss://offchain.pub",
      ]);
    });

    it("dedups and caps the target set", async () => {
      const many = Array.from({ length: 12 }, (_, i) => [
        "r",
        `wss://relay-${i % 9}.example.com`,
      ]);
      fetchDbMock.mockResolvedValue([relayEvent(many as string[][])]);
      const relays = await getRecipientReadRelays(PAYEE);
      expect(relays.length).toBe(8); // 9 unique, capped at 8
      expect(new Set(relays).size).toBe(relays.length);
    });

    it("passes valid entries through byte-identical", async () => {
      fetchDbMock.mockResolvedValue([relayEvent([["r", "wss://nostr.mom"]])]);
      await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([
        "wss://nostr.mom",
      ]);
    });

    it("drops public-looking hosts that DNS-resolve to private space", async () => {
      fetchDbMock.mockResolvedValue([
        relayEvent([
          ["r", "wss://private-dns.example.com"],
          ["r", "wss://nostr.mom"],
        ]),
      ]);
      await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([
        "wss://nostr.mom",
      ]);
    });

    it("a stuck resolver is dropped fail-closed within the DNS deadline", async () => {
      fetchDbMock.mockResolvedValue([
        relayEvent([
          ["r", "wss://stuck-dns.example.com"],
          ["r", "wss://nostr.mom"],
        ]),
      ]);
      const start = Date.now();
      await expect(getRecipientReadRelays(PAYEE)).resolves.toEqual([
        "wss://nostr.mom",
      ]);
      // 2s DNS deadline — proves a hung resolver can't stall resolution.
      expect(Date.now() - start).toBeLessThan(10000);
    });
  });
});
