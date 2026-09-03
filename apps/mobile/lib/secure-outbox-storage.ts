import * as SecureStore from "expo-secure-store";
import { generateSecretKey, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

import type { AsyncKeyValueStorage } from "./order-notification-outbox";

// The seller-order notification outbox persists signed gift-wraps so failed
// buyer notifications can be republished. Gift-wraps reveal order metadata
// (buyer p-tag, timing) even though their content is encrypted, so plaintext
// AsyncStorage is not an acceptable at-rest story. Values are encrypted with
// NIP-44 v2 using a random device key held in the OS keychain (SecureStore);
// AsyncStorage only ever sees ciphertext.
const SECURE_STORE_KEY_ID = "milk-market.seller-order-outbox-key.v1";
const ENCRYPTED_PREFIX = "v1:";
const KEY_HEX = /^[0-9a-f]{64}$/;

let keyPromise: Promise<Uint8Array> | null = null;

// Single-flight: concurrent first-time writes must not race two generated
// keys, or entries written with the losing key become undecryptable. A
// rejected promise (transient SecureStore failure) must NOT stay cached —
// reset it so the next operation retries instead of bricking the outbox
// until process restart.
function getOrCreateKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    const pending = (async () => {
      const existing = await SecureStore.getItemAsync(SECURE_STORE_KEY_ID);
      if (existing && KEY_HEX.test(existing)) {
        return hexToBytes(existing);
      }
      const fresh = generateSecretKey();
      await SecureStore.setItemAsync(SECURE_STORE_KEY_ID, bytesToHex(fresh));
      return fresh;
    })();
    pending.catch(() => {
      keyPromise = null;
    });
    keyPromise = pending;
  }
  return keyPromise;
}

// The base store (AsyncStorage) is injected rather than imported so this
// module stays free of untranspiled React Native deps and remains unit-testable.
export function createSecureOutboxStorage(
  base: AsyncKeyValueStorage
): AsyncKeyValueStorage {
  return {
    getAllKeys: () => base.getAllKeys(),
    async getItem(key) {
      const raw = await base.getItem(key);
      if (raw === null) {
        return null;
      }
      if (!raw.startsWith(ENCRYPTED_PREFIX)) {
        // Legacy plaintext entry written before encryption landed.
        return raw;
      }
      try {
        const encryptionKey = await getOrCreateKey();
        return nip44.v2.decrypt(
          raw.slice(ENCRYPTED_PREFIX.length),
          encryptionKey
        );
      } catch {
        // Undecryptable (key lost/rotated): report as absent so the outbox
        // prunes the entry instead of crashing every load.
        return null;
      }
    },
    async setItem(key, value) {
      const encryptionKey = await getOrCreateKey();
      await base.setItem(
        key,
        ENCRYPTED_PREFIX + nip44.v2.encrypt(value, encryptionKey)
      );
    },
    removeItem: (key) => base.removeItem(key),
  };
}
