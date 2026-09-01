import {
  fetchNip58ProfileBadges,
  MAX_NIP58_PROFILE_BADGES,
  parseNip58ProfileBadgesEvent,
  selectLatestNip58ProfileBadgesEvent,
} from "../badges";

const issuer = "a".repeat(64);
const recipient = "b".repeat(64);
const awardId = "c".repeat(64);
const address = `30009:${issuer}:supporter`;

const event = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "d".repeat(64),
    pubkey: recipient,
    kind: 10008,
    created_at: 1,
    content: "",
    sig: "e".repeat(128),
    tags: [],
    ...overrides,
  }) as any;

describe("NIP-58 badge resolution", () => {
  it("caps duplicate profile references and selects deterministic replacements", () => {
    const profile = event({
      tags: Array.from({ length: MAX_NIP58_PROFILE_BADGES + 2 }, () => [
        "a", address,
      ]).flatMap((tag) => [tag, ["e", awardId]]),
    });
    expect(parseNip58ProfileBadgesEvent(profile)).toHaveLength(1);
    expect(selectLatestNip58ProfileBadgesEvent([
      event({ id: "f".repeat(64), created_at: 2 }),
      event({ id: "a".repeat(64), created_at: 2 }),
    ])?.id).toBe("a".repeat(64));
  });

  it("does not resolve an award whose issuer or recipient does not match", async () => {
    const fetchWithStatus = jest
      .fn()
      .mockResolvedValueOnce({
        events: [event({ tags: [["a", address], ["e", awardId]] })],
        complete: true,
      })
      .mockResolvedValueOnce({
        events: [event({ id: awardId, pubkey: issuer, kind: 8, tags: [["a", address], ["p", "f".repeat(64)]] })],
        complete: true,
      });

    const result = await fetchNip58ProfileBadges(
      { fetchWithStatus } as any,
      ["wss://relay.example"],
      [recipient]
    );

    expect(result.get(recipient)).toEqual({ badges: [], complete: true });
  });

  it("does not follow profile relay hints and propagates incomplete fetches", async () => {
    const configuredRelay = "wss://trusted.example";
    const attackerRelay = "wss://attacker.example";
    const fetchWithStatus = jest
      .fn()
      .mockResolvedValueOnce({
        events: [
          event({
            tags: [
              ["a", address, attackerRelay],
              ["e", awardId, attackerRelay],
            ],
          }),
        ],
        complete: true,
      })
      .mockResolvedValueOnce({ events: [], complete: false });

    const result = await fetchNip58ProfileBadges(
      { fetchWithStatus } as any,
      [configuredRelay],
      [recipient]
    );

    expect(fetchWithStatus).toHaveBeenCalledTimes(2);
    expect(
      fetchWithStatus.mock.calls.every((call) => call[2] === undefined || call[2].includes(configuredRelay))
    ).toBe(true);
    expect(fetchWithStatus.mock.calls.flatMap((call) => call[2] || [])).not.toContain(
      attackerRelay
    );
    expect(result.get(recipient)).toEqual({ badges: [], complete: false });
  });
});