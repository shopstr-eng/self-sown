/**
 * fetchKind10002FromIndexers: relay responses are untrusted — only a
 * kind-10002 event with a valid signature by the claimed author is usable,
 * newest verified event wins, every indexer failure is contained (each
 * indexer has its own bounded session — see contained-relay.test.ts), and
 * the indexer list is operator-overridable.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { fetchKind10002FromIndexers } from "@/utils/nostr/nip65-indexer-fetch";

const queryMock = jest.fn();
jest.mock("@/utils/nostr/contained-relay", () => ({
  queryRelayEvents: (...args: unknown[]) => queryMock(...args),
}));

const skA = generateSecretKey();
const skB = generateSecretKey();
const pkA = getPublicKey(skA);

const relayList = (sk: Uint8Array, createdAt: number, kind = 10002) =>
  finalizeEvent(
    {
      kind,
      created_at: createdAt,
      content: "",
      tags: [["r", "wss://nostr.mom"]],
    },
    sk
  );

describe("fetchKind10002FromIndexers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NIP65_INDEXER_RELAYS;
  });

  it("rejects malformed pubkeys without touching the network", async () => {
    await expect(fetchKind10002FromIndexers("nope")).resolves.toBeNull();
    await expect(
      fetchKind10002FromIndexers(pkA.toUpperCase())
    ).resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns the newest VERIFIED event by the claimed author", async () => {
    const older = relayList(skA, 1000);
    const newer = relayList(skA, 2000);
    const impostor = relayList(skB, 3000); // newest but signed by someone else
    queryMock.mockResolvedValue([older, impostor, newer]);
    const result = await fetchKind10002FromIndexers(pkA);
    expect(result?.id).toBe(newer.id);
  });

  it("drops events with the wrong kind even when the signature is valid", async () => {
    const wrongKind = relayList(skA, 3000, 10003);
    const right = relayList(skA, 1000);
    queryMock.mockResolvedValue([wrongKind, right]);
    const result = await fetchKind10002FromIndexers(pkA);
    expect(result?.id).toBe(right.id);
  });

  it("drops tampered events (invalid signature)", async () => {
    // JSON round-trip strips the Symbol(verified) marker finalizeEvent stamps
    // (relay-delivered events never carry it — they arrive as plain JSON).
    const valid = JSON.parse(JSON.stringify(relayList(skA, 1000)));
    const tampered = { ...valid, created_at: 9000 };
    queryMock.mockResolvedValue([tampered]);
    await expect(fetchKind10002FromIndexers(pkA)).resolves.toBeNull();
  });

  it("one indexer returning nothing does not discard the other's results", async () => {
    const hit = relayList(skA, 1000);
    queryMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("purplepag.es") ? [] : [hit])
    );
    const result = await fetchKind10002FromIndexers(pkA);
    expect(result?.id).toBe(hit.id);
  });

  it("returns null when no indexer has a usable event", async () => {
    queryMock.mockResolvedValue([]);
    await expect(fetchKind10002FromIndexers(pkA)).resolves.toBeNull();
  });

  it("honors the NIP65_INDEXER_RELAYS override with operator-trusted sessions", async () => {
    process.env.NIP65_INDEXER_RELAYS =
      "ws://127.0.0.1:47777, wss://idx.example";
    queryMock.mockResolvedValue([]);
    await fetchKind10002FromIndexers(pkA);
    expect(queryMock).toHaveBeenCalledWith(
      "ws://127.0.0.1:47777",
      expect.objectContaining({ kinds: [10002], authors: [pkA] }),
      expect.objectContaining({ allowPrivate: true })
    );
    expect(queryMock).toHaveBeenCalledWith(
      "wss://idx.example",
      expect.anything(),
      expect.objectContaining({ allowPrivate: true })
    );
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("built-in default indexers use the pinned public-only lookup", async () => {
    queryMock.mockResolvedValue([]);
    await fetchKind10002FromIndexers(pkA);
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const call of queryMock.mock.calls) {
      expect(call[0]).toMatch(/^wss:\/\//);
      expect(call[2]).toEqual(expect.objectContaining({ allowPrivate: false }));
    }
  });
});
