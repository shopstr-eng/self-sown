import {
  clearNWCConnection,
  getLocalStorageData,
  lockNWCConnection,
  saveEncryptedNWCString,
  saveNWCInfo,
  unlockNWCString,
} from "../nostr-helper-functions";
import { storage, STORAGE_KEYS } from "@/utils/storage";

describe("StorageManager defaults (replaces getLocalStorageData)", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
    clearNWCConnection();
  });

  it("returns safe defaults for missing keys", () => {
    expect(storage.getJson(STORAGE_KEYS.RELAYS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.MINTS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.TOKENS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.HISTORY, [])).toEqual([]);
  });

  it("recovers from malformed JSON in critical keys", () => {
    localStorage.setItem("relays", "{bad");
    localStorage.setItem("mints", "{bad");
    localStorage.setItem("tokens", "{bad");
    localStorage.setItem("history", "{bad");
    localStorage.setItem("signer", "{bad");

    expect(() => storage.getJson(STORAGE_KEYS.RELAYS, [])).not.toThrow();
    expect(storage.getJson(STORAGE_KEYS.RELAYS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.MINTS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.TOKENS, [])).toEqual([]);
    expect(storage.getJson(STORAGE_KEYS.HISTORY, [])).toEqual([]);
  });

  it("reads and writes data correctly", () => {
    const relays = ["wss://relay.damus.io"];
    storage.setJson(STORAGE_KEYS.RELAYS, relays);
    expect(storage.getJson(STORAGE_KEYS.RELAYS, [])).toEqual(relays);
  });

  it("returns string items correctly", () => {
    storage.setItem(STORAGE_KEYS.NWC_STRING, "nostr+walletconnect://test");
    expect(storage.getItem(STORAGE_KEYS.NWC_STRING)).toBe(
      "nostr+walletconnect://test"
    );
  });

  it("stores the NWC connection encrypted at rest and keeps the raw value in runtime memory", () => {
    saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    saveNWCInfo({ alias: "Alby", methods: ["pay_invoice"] });

    const data = getLocalStorageData();

    expect(data.nwcString).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd"
    );
    expect(data.nwcInfo).toBe(
      JSON.stringify({ alias: "Alby", methods: ["pay_invoice"] })
    );
    expect(data.hasStoredNWCConnection).toBe(true);
    expect(localStorage.getItem("nwcString")).toBeNull();
    expect(localStorage.getItem("encryptedNWCString")).not.toBeNull();
    expect(localStorage.getItem("nwcInfo")).toBe(
      JSON.stringify({ alias: "Alby", methods: ["pay_invoice"] })
    );
  });

  it("unlocks the stored NWC connection with the correct passphrase", () => {
    saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    lockNWCConnection();

    expect(getLocalStorageData().nwcString).toBeNull();

    const unlocked = unlockNWCString("secret-passphrase");

    expect(unlocked).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd"
    );
    expect(getLocalStorageData().nwcString).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd"
    );
  });

  it("does not unlock the stored NWC connection with an incorrect passphrase", () => {
    saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    lockNWCConnection();

    expect(() => unlockNWCString("wrong-passphrase")).toThrow(
      "Incorrect passphrase or invalid NWC connection."
    );
    expect(getLocalStorageData().nwcString).toBeNull();
  });

  it("preserves legacy persisted plaintext NWC data for migration", () => {
    localStorage.setItem(
      "nwcString",
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );
    localStorage.setItem("encryptedNWCString", "ciphertext");
    localStorage.setItem(
      "nwcInfo",
      JSON.stringify({ alias: "Legacy", methods: ["pay_invoice"] })
    );

    const data = getLocalStorageData();

    expect(data.nwcString).toBeNull();
    expect(data.legacyNWCString).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );
    expect(data.nwcInfo).toBe(
      JSON.stringify({ alias: "Legacy", methods: ["pay_invoice"] })
    );
    expect(data.hasStoredNWCConnection).toBe(true);
    expect(data.hasLegacyNWCConnection).toBe(false);
    expect(localStorage.getItem("nwcString")).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );
  });

  it("flags an unmigrated legacy plaintext NWC connection without treating it as unlocked", () => {
    localStorage.setItem(
      "nwcString",
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );
    localStorage.setItem(
      "nwcInfo",
      JSON.stringify({ alias: "Legacy", methods: ["pay_invoice"] })
    );

    const data = getLocalStorageData();

    expect(data.nwcString).toBeNull();
    expect(data.legacyNWCString).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );
    expect(data.hasStoredNWCConnection).toBe(false);
    expect(data.hasLegacyNWCConnection).toBe(true);
  });

  it("removes the legacy plaintext NWC value once it is re-encrypted", () => {
    localStorage.setItem(
      "nwcString",
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );

    saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret",
      "secret-passphrase"
    );

    const data = getLocalStorageData();

    expect(data.legacyNWCString).toBeNull();
    expect(data.hasLegacyNWCConnection).toBe(false);
    expect(data.hasStoredNWCConnection).toBe(true);
    expect(localStorage.getItem("nwcString")).toBeNull();
  });
});
