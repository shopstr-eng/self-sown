/**
 * publishToRelays: fans the event out to each relay through its own
 * contained, DNS-pinned session and counts only the relays that acked.
 * (Deadline/error containment of a single session is covered by
 * contained-relay.test.ts.)
 */
import { publishToRelays } from "@/utils/nostr/server-nostr-helpers";

const publishMock = jest.fn();
jest.mock("@/utils/nostr/contained-relay", () => ({
  publishEventToRelay: (...args: unknown[]) => publishMock(...args),
}));
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  getDbPool: jest.fn(),
  fetchRelayConfigFromDb: jest.fn(),
}));

const EVENT = { id: "a".repeat(64), kind: 1059 } as any;

describe("publishToRelays", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fans out per relay and counts only acked publishes", async () => {
    publishMock.mockImplementation((url: string) =>
      Promise.resolve(!url.includes("bad"))
    );
    const n = await publishToRelays(
      EVENT,
      ["wss://a.example", "wss://bad.example", "wss://b.example"],
      200
    );
    expect(n).toBe(2);
    expect(publishMock).toHaveBeenCalledTimes(3);
    expect(publishMock).toHaveBeenCalledWith(
      "wss://bad.example",
      EVENT,
      expect.objectContaining({ timeoutMs: 200 })
    );
  });

  it("returns 0 when every relay fails", async () => {
    publishMock.mockResolvedValue(false);
    await expect(publishToRelays(EVENT, ["wss://a.example"], 200)).resolves.toBe(0);
  });
});
