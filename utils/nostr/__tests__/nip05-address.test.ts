import { nip05AddressFromNames } from "../nip05-address";

const PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";

describe("nip05AddressFromNames", () => {
  it("returns name@host for the matching entry", () => {
    expect(
      nip05AddressFromNames({
        names: { alice: PUBKEY },
        pubkey: PUBKEY,
        host: "example.com",
      })
    ).toBe("alice@example.com");
  });

  it("prefers the exact-case key inserted before its lower-cased alias", () => {
    // nostr-json.ts inserts `names[username]` before `names[username.toLowerCase()]`.
    expect(
      nip05AddressFromNames({
        names: { Alice: PUBKEY, alice: PUBKEY },
        pubkey: PUBKEY,
        host: "example.com",
      })
    ).toBe("Alice@example.com");
  });

  it("prefers the first matching key when several names map to the pubkey", () => {
    expect(
      nip05AddressFromNames({
        names: { first: PUBKEY, second: PUBKEY },
        pubkey: PUBKEY,
        host: "example.com",
      })
    ).toBe("first@example.com");
  });

  it("matches the pubkey value case-insensitively", () => {
    expect(
      nip05AddressFromNames({
        names: { alice: PUBKEY.toUpperCase() },
        pubkey: PUBKEY,
        host: "example.com",
      })
    ).toBe("alice@example.com");
  });

  it("trims and lower-cases the host", () => {
    expect(
      nip05AddressFromNames({
        names: { alice: PUBKEY },
        pubkey: PUBKEY,
        host: "  Example.COM ",
      })
    ).toBe("alice@example.com");
  });

  it("returns null when the pubkey is not named", () => {
    expect(
      nip05AddressFromNames({
        names: { bob: "f".repeat(64) },
        pubkey: PUBKEY,
        host: "example.com",
      })
    ).toBeNull();
  });

  it("returns null on empty names, empty host, or empty pubkey", () => {
    expect(
      nip05AddressFromNames({ names: {}, pubkey: PUBKEY, host: "example.com" })
    ).toBeNull();
    expect(
      nip05AddressFromNames({
        names: { alice: PUBKEY },
        pubkey: PUBKEY,
        host: "   ",
      })
    ).toBeNull();
    expect(
      nip05AddressFromNames({
        names: { alice: PUBKEY },
        pubkey: "",
        host: "example.com",
      })
    ).toBeNull();
  });
});
