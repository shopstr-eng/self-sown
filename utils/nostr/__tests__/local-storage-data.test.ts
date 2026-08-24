import {
  LogOut,
  clearNWCConnection,
  getLocalStorageData,
  lockNWCConnection,
  saveEncryptedNWCString,
  saveNWCInfo,
  setLocalStorageDataOnSignIn,
  unlockNWCString,
} from "../nostr-helper-functions";
import { storage, STORAGE_KEYS } from "@/utils/storage";
import { webcrypto } from "node:crypto";

const originalCrypto = globalThis.crypto;

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
});

describe("StorageManager defaults (replaces getLocalStorageData)", () => {
  beforeEach(() => {
    LogOut();
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

  it("falls back to signInMethod signer when stored signer shape is invalid", () => {
    localStorage.setItem("signInMethod", "extension");
    localStorage.setItem("signer", JSON.stringify({ type: "bad" }));

    const data = getLocalStorageData();

    expect(data.signer).toEqual({ type: "nip07" });
    expect(localStorage.getItem("signer")).toBeNull();
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

  it("stores the NWC connection encrypted at rest and keeps the raw value in runtime memory", async () => {
    await saveEncryptedNWCString(
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

  it("stores NWC credentials in a versioned authenticated envelope", async () => {
    await saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );

    const envelope = JSON.parse(
      localStorage.getItem("encryptedNWCString") || ""
    );

    expect(envelope).toMatchObject({
      version: 1,
      kdf: "PBKDF2-SHA-256",
      iterations: expect.any(Number),
      cipher: "AES-256-GCM",
      salt: expect.any(String),
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(envelope.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("rejects passphrases shorter than twelve characters", async () => {
    await expect(
      Promise.resolve().then(() =>
        saveEncryptedNWCString(
          "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
          "too-short"
        )
      )
    ).rejects.toThrow("at least 12 characters");
  });

  it("unlocks the stored NWC connection with the correct passphrase", async () => {
    await saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    lockNWCConnection();

    expect(getLocalStorageData().nwcString).toBeNull();

    const unlocked = await unlockNWCString("secret-passphrase");

    expect(unlocked).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd"
    );
    expect(getLocalStorageData().nwcString).toBe(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd"
    );
  });

  it("does not unlock the stored NWC connection with an incorrect passphrase", async () => {
    await saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    lockNWCConnection();

    await expect(unlockNWCString("wrong-passphrase")).rejects.toThrow(
      "Incorrect passphrase or invalid NWC connection."
    );
    expect(getLocalStorageData().nwcString).toBeNull();
  });

  it("rejects a tampered encrypted NWC connection", async () => {
    await saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=abcd",
      "secret-passphrase"
    );
    lockNWCConnection();

    const envelope = JSON.parse(
      localStorage.getItem("encryptedNWCString") || ""
    );
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    localStorage.setItem("encryptedNWCString", JSON.stringify(envelope));

    await expect(unlockNWCString("secret-passphrase")).rejects.toThrow(
      "Incorrect passphrase or invalid NWC connection."
    );
    expect(getLocalStorageData().nwcString).toBeNull();
  });

  it("removes legacy plaintext even when encrypted NWC data also exists", () => {
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
    expect(data.legacyNWCString).toBeNull();
    expect(data.nwcInfo).toBe(
      JSON.stringify({ alias: "Legacy", methods: ["pay_invoice"] })
    );
    expect(data.hasStoredNWCConnection).toBe(true);
    expect(data.hasLegacyNWCConnection).toBe(false);
    expect(localStorage.getItem("nwcString")).toBeNull();
  });

  it("removes an unmigrated legacy plaintext NWC connection after reading it", () => {
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
    expect(localStorage.getItem("nwcString")).toBeNull();
  });

  it("keeps a removed legacy connection available in memory for migration", () => {
    const legacyNWCString =
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret";
    localStorage.setItem("nwcString", legacyNWCString);

    expect(getLocalStorageData().legacyNWCString).toBe(legacyNWCString);
    expect(localStorage.getItem("nwcString")).toBeNull();
    expect(getLocalStorageData().legacyNWCString).toBe(legacyNWCString);
    expect(getLocalStorageData().hasLegacyNWCConnection).toBe(true);
  });

  it("removes the legacy plaintext NWC value once it is re-encrypted", async () => {
    localStorage.setItem(
      "nwcString",
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret"
    );

    await saveEncryptedNWCString(
      "nostr+walletconnect://wallet?relay=wss://relay&secret=legacysecret",
      "secret-passphrase"
    );

    const data = getLocalStorageData();

    expect(data.legacyNWCString).toBeNull();
    expect(data.hasLegacyNWCConnection).toBe(false);
    expect(data.hasStoredNWCConnection).toBe(true);
    expect(localStorage.getItem("nwcString")).toBeNull();
  });

  it("accepts a marker-only nip46 stored signer", () => {
    localStorage.setItem("signer", JSON.stringify({ type: "nip46" }));

    const data = getLocalStorageData();

    expect(data.signer).toEqual({ type: "nip46" });
    expect(localStorage.getItem("signer")).toBe(
      JSON.stringify({ type: "nip46" })
    );
  });

  it("reconstructs a marker-only nip46 signer from separate bunker keys", () => {
    localStorage.setItem("signer", JSON.stringify({ type: "nip46" }));
    localStorage.setItem("clientPrivkey", "client-private-key");
    localStorage.setItem("bunkerRemotePubkey", "remote-pubkey");
    localStorage.setItem("bunkerRelays", JSON.stringify(["wss://relay.one"]));
    localStorage.setItem("bunkerSecret", "stored-secret");

    const data = getLocalStorageData();

    expect(data.signer).toEqual({
      type: "nip46",
      bunker:
        "bunker://remote-pubkey?secret=stored-secret&relay=wss://relay.one",
      appPrivKey: "client-private-key",
    });
    expect(localStorage.getItem("signer")).toBe(
      JSON.stringify({ type: "nip46" })
    );
  });

  it("stores only a safe nip46 signer marker while keeping runtime signer data", () => {
    setLocalStorageDataOnSignIn({
      signer: {
        toJSON: () => ({
          type: "nip46",
          bunker: "bunker://pubkey?secret=supersecret",
          appPrivKey: "app-private-key",
        }),
      } as any,
    });

    const data = getLocalStorageData();

    expect(data.signer).toEqual({
      type: "nip46",
      bunker: "bunker://pubkey?secret=supersecret",
      appPrivKey: "app-private-key",
    });
    expect(localStorage.getItem("signer")).toBe(
      JSON.stringify({ type: "nip46" })
    );
  });

  it("migrates legacy persisted bunker signer data to a safe marker on read", () => {
    localStorage.setItem(
      "signer",
      JSON.stringify({
        type: "nip46",
        bunker: "bunker://pubkey?secret=legacysecret",
        appPrivKey: "legacy-app-privkey",
      })
    );
    localStorage.setItem("clientPrivkey", "client-private-key");
    localStorage.setItem("bunkerRemotePubkey", "remote-pubkey");
    localStorage.setItem("bunkerRelays", JSON.stringify(["wss://relay.one"]));
    localStorage.setItem("bunkerSecret", "stored-secret");

    const data = getLocalStorageData();

    expect(data.signer).toEqual({
      type: "nip46",
      bunker:
        "bunker://remote-pubkey?secret=stored-secret&relay=wss://relay.one",
      appPrivKey: "client-private-key",
    });
    expect(localStorage.getItem("signer")).toBe(
      JSON.stringify({ type: "nip46" })
    );
  });
});
