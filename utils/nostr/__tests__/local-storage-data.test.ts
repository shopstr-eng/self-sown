import {
  getDefaultBlossomServer,
  getDefaultMint,
  getDefaultRelays,
  getLocalStorageData,
} from "../nostr-helper-functions";

describe("getLocalStorageData", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.restoreAllMocks();
  });

  it("returns safe defaults for missing keys", () => {
    const data = getLocalStorageData();

    expect(data.relays).toEqual(getDefaultRelays());
    expect(data.mints).toEqual([getDefaultMint()]);
    expect(data.blossomServers).toEqual([getDefaultBlossomServer()]);
    expect(data.tokens).toEqual([]);
    expect(data.history).toEqual([]);
  });

  it("recovers from malformed JSON in critical keys", () => {
    localStorage.setItem("relays", "{bad");
    localStorage.setItem("readRelays", "{bad");
    localStorage.setItem("writeRelays", "{bad");
    localStorage.setItem("mints", "{bad");
    localStorage.setItem("blossomServers", "{bad");
    localStorage.setItem("tokens", "{bad");
    localStorage.setItem("history", "{bad");
    localStorage.setItem("bunkerRelays", "{bad");
    localStorage.setItem("signer", "{bad");

    expect(() => getLocalStorageData()).not.toThrow();

    const data = getLocalStorageData();
    expect(data.relays).toEqual(getDefaultRelays());
    expect(data.readRelays).toEqual([]);
    expect(data.writeRelays).toEqual([]);
    expect(data.mints).toEqual([getDefaultMint()]);
    expect(data.blossomServers).toEqual([getDefaultBlossomServer()]);
    expect(data.tokens).toEqual([]);
    expect(data.history).toEqual([]);
    expect(data.bunkerRelays).toEqual([]);
  });

  it("falls back to signInMethod signer when stored signer shape is invalid", () => {
    localStorage.setItem("signInMethod", "extension");
    localStorage.setItem("signer", JSON.stringify({ type: "nip46" }));

    const data = getLocalStorageData();

    expect(data.signer).toEqual({ type: "nip07" });
  });

  it("keeps valid stored signer shape", () => {
    localStorage.setItem(
      "signer",
      JSON.stringify({
        type: "nsec",
        encryptedPrivKey: "ncryptsec1mock",
      })
    );

    const data = getLocalStorageData();

    expect(data.signer).toEqual({
      type: "nsec",
      encryptedPrivKey: "ncryptsec1mock",
    });
  });

  it("keeps legacy NWC credentials recoverable while using only session storage", () => {
    localStorage.setItem(
      "nwcString",
      "nostr+walletconnect://wallet.example?secret=secret"
    );

    expect(getLocalStorageData().nwcString).toContain("secret=secret");
    expect(localStorage.getItem("nwcString")).toContain("secret=secret");
    expect(sessionStorage.getItem("nwcString")).toContain("secret=secret");
  });

  it("does not delete legacy NIP-46 credentials before encryption succeeds", () => {
    localStorage.setItem("signInMethod", "bunker");
    localStorage.setItem("clientPrivkey", "legacy-app-key");
    localStorage.setItem("bunkerRemotePubkey", "legacy-bunker");
    localStorage.setItem("bunkerSecret", "legacy-capability");
    localStorage.setItem("bunkerRelays", JSON.stringify(["wss://relay.example"]));

    expect(getLocalStorageData().signer).toEqual(
      expect.objectContaining({ type: "nip46", appPrivKey: "legacy-app-key" })
    );
    expect(localStorage.getItem("clientPrivkey")).toBe("legacy-app-key");
    expect(localStorage.getItem("bunkerSecret")).toBe("legacy-capability");
  });
});
