/** @jest-environment node */

// Shared across jest.resetModules() re-instantiations of the factory so tests
// can inspect what the freshly-imported module wrote. failNextGet/Set inject
// transient keychain failures.
const mockSecureStoreValues = new Map<string, string>();
const mockSecureStoreState = { failNextGet: 0, failNextSet: 0 };

jest.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    if (mockSecureStoreState.failNextGet > 0) {
      mockSecureStoreState.failNextGet -= 1;
      throw new Error("keychain temporarily unavailable");
    }
    return mockSecureStoreValues.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (mockSecureStoreState.failNextSet > 0) {
      mockSecureStoreState.failNextSet -= 1;
      throw new Error("keychain temporarily unavailable");
    }
    mockSecureStoreValues.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockSecureStoreValues.delete(key);
  },
}));

import { nip19 } from "nostr-tools";

import type { AsyncKeyValueStorage } from "@/apps/mobile/lib/order-notification-outbox";

function createMemoryStorage(): AsyncKeyValueStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getAllKeys: async () => Array.from(values.keys()),
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

async function freshSecureStorage(base: AsyncKeyValueStorage) {
  // Each test gets a fresh module instance so the cached key promise resets.
  jest.resetModules();
  const mod = await import("@/apps/mobile/lib/secure-outbox-storage");
  return mod.createSecureOutboxStorage(base);
}

describe("createSecureOutboxStorage", () => {
  it("encrypts values at rest and round-trips them", async () => {
    const base = createMemoryStorage();
    const storage = await freshSecureStorage(base);
    const plaintext = JSON.stringify({
      buyerPubkey: "b".repeat(64),
      orderId: "order-123",
    });

    await storage.setItem("outbox:key", plaintext);

    const storedRaw = base.values.get("outbox:key");
    expect(storedRaw).toBeDefined();
    expect(storedRaw).not.toContain("order-123");
    expect(storedRaw).not.toContain("b".repeat(64));
    expect(storedRaw!.startsWith("v1:")).toBe(true);
    await expect(storage.getItem("outbox:key")).resolves.toBe(plaintext);
  });

  it("generates the device key once and reuses it across writes", async () => {
    mockSecureStoreValues.clear();
    const base = createMemoryStorage();
    const storage = await freshSecureStorage(base);

    await storage.setItem("a", "one");
    await storage.setItem("b", "two");

    expect(mockSecureStoreValues.size).toBe(1);
    await expect(storage.getItem("a")).resolves.toBe("one");
    await expect(storage.getItem("b")).resolves.toBe("two");
  });

  it("passes through legacy plaintext entries written before encryption", async () => {
    const base = createMemoryStorage();
    base.values.set("outbox:legacy", JSON.stringify({ orderId: "old-1" }));
    const storage = await freshSecureStorage(base);

    await expect(storage.getItem("outbox:legacy")).resolves.toBe(
      JSON.stringify({ orderId: "old-1" })
    );
  });

  it("treats undecryptable entries as absent so the outbox prunes them", async () => {
    const base = createMemoryStorage();
    // Valid v1 envelope but encrypted under a different key.
    const otherKey = nip19.decode(nip19.nsecEncode(new Uint8Array(32).fill(7)))
      .data as Uint8Array;
    const { nip44 } = await import("nostr-tools");
    base.values.set(
      "outbox:corrupt",
      "v1:" + nip44.v2.encrypt("secret", otherKey)
    );
    const storage = await freshSecureStorage(base);

    await expect(storage.getItem("outbox:corrupt")).resolves.toBeNull();
  });

  it("retries key initialization after a transient SecureStore failure", async () => {
    mockSecureStoreValues.clear();
    mockSecureStoreState.failNextGet = 1;
    const base = createMemoryStorage();
    const storage = await freshSecureStorage(base);

    // First attempt fails while reading the keychain.
    await expect(storage.setItem("k", "v")).rejects.toThrow(
      "keychain temporarily unavailable"
    );
    // The rejected key promise must not stay cached: the next write retries
    // key init from scratch and succeeds.
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
    expect(mockSecureStoreValues.size).toBe(1);
  });

  it("delegates key listing and removal to the base storage", async () => {
    const base = createMemoryStorage();
    const storage = await freshSecureStorage(base);

    await storage.setItem("x", "1");
    expect(await storage.getAllKeys()).toEqual(["x"]);
    await storage.removeItem("x");
    expect(await storage.getAllKeys()).toEqual([]);
    expect(base.values.size).toBe(0);
  });
});
