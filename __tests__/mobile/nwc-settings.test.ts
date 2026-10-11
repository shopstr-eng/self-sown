/** @jest-environment node */

const asyncStorageStore = new Map<string, string>();

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
  }),
  { virtual: true }
);

const secureStoreState = new Map<string, string>();

jest.mock(
  "expo-secure-store",
  () => ({
    getItemAsync: jest.fn(
      async (key: string) => secureStoreState.get(key) ?? null
    ),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      secureStoreState.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      secureStoreState.delete(key);
    }),
  }),
  { virtual: true }
);

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  type Event,
} from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

import {
  buildNwcRequestEvent,
  clearNwcConnection,
  decryptNwcResponseContent,
  loadNwcConnection,
  parseNwcConnectionString,
  saveNwcConnection,
  selectNwcEncryption,
  validateNwcConnectionString,
} from "@/apps/mobile/lib/nwc";

const WALLET_SECRET = generateSecretKey();
const WALLET_PUBKEY = getPublicKey(WALLET_SECRET);
const CLIENT_SECRET_HEX = bytesToHex(generateSecretKey());

const VALID_CONNECTION = `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com&secret=${CLIENT_SECRET_HEX}`;

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

beforeEach(() => {
  asyncStorageStore.clear();
  secureStoreState.clear();
});

describe("parseNwcConnectionString", () => {
  it("parses a valid connection string with a percent-encoded relay", () => {
    const details = parseNwcConnectionString(VALID_CONNECTION);
    expect(details.walletPubkey).toBe(WALLET_PUBKEY);
    expect(details.relays).toEqual(["wss://relay.example.com"]);
    expect(details.secret).toBe(CLIENT_SECRET_HEX);
  });

  it("supports multiple relay params and trims whitespace", () => {
    const details = parseNwcConnectionString(
      `  nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Fa.example.com&relay=wss%3A%2F%2Fb.example.com&secret=${CLIENT_SECRET_HEX}  `
    );
    expect(details.relays).toEqual([
      "wss://a.example.com",
      "wss://b.example.com",
    ]);
  });

  it.each([
    ["wrong scheme", `https://${WALLET_PUBKEY}?relay=wss%3A%2F%2Fr.example.com&secret=${CLIENT_SECRET_HEX}`],
    ["missing secret", `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Fr.example.com`],
    ["short secret", `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Fr.example.com&secret=abcd`],
    ["missing relay", `nostr+walletconnect://${WALLET_PUBKEY}?secret=${CLIENT_SECRET_HEX}`],
    ["non-websocket relay", `nostr+walletconnect://${WALLET_PUBKEY}?relay=https%3A%2F%2Fr.example.com&secret=${CLIENT_SECRET_HEX}`],
    ["invalid wallet pubkey", `nostr+walletconnect://nothex?relay=wss%3A%2F%2Fr.example.com&secret=${CLIENT_SECRET_HEX}`],
  ])("rejects %s", (_label, value) => {
    expect(() => parseNwcConnectionString(value)).toThrow();
    expect(validateNwcConnectionString(value)).not.toBeNull();
  });

  it("requires a non-empty value", () => {
    expect(validateNwcConnectionString("   ")).toBe(
      "A connection string is required."
    );
    expect(validateNwcConnectionString(VALID_CONNECTION)).toBeNull();
  });
});

describe("pubkey-scoped storage", () => {
  const info = { alias: "Test Wallet", methods: ["get_balance", "pay_invoice"] };

  it("round-trips a saved connection", async () => {
    await saveNwcConnection(PUBKEY_A, VALID_CONNECTION, info);
    const saved = await loadNwcConnection(PUBKEY_A);
    expect(saved?.connectionString).toBe(VALID_CONNECTION);
    expect(saved?.info).toEqual(info);
  });

  it("keeps the connection secret out of plaintext AsyncStorage", async () => {
    await saveNwcConnection(PUBKEY_A, VALID_CONNECTION, info);
    for (const value of asyncStorageStore.values()) {
      expect(value).not.toContain(CLIENT_SECRET_HEX);
    }
    expect(
      [...secureStoreState.values()].some((value) =>
        value.includes(CLIENT_SECRET_HEX)
      )
    ).toBe(true);
  });

  it("one account cannot read another account's wallet connection", async () => {
    await saveNwcConnection(PUBKEY_A, VALID_CONNECTION, info);
    expect(await loadNwcConnection(PUBKEY_B)).toBeNull();

    const keys = [...asyncStorageStore.keys(), ...secureStoreState.keys()];
    expect(keys).toEqual(
      expect.arrayContaining([expect.stringContaining(PUBKEY_A)])
    );
    expect(keys.every((key) => !key.endsWith(":nwc"))).toBe(true);
  });

  it("clearing removes the secret and the cached info", async () => {
    await saveNwcConnection(PUBKEY_A, VALID_CONNECTION, info);
    await clearNwcConnection(PUBKEY_A);
    expect(await loadNwcConnection(PUBKEY_A)).toBeNull();
    expect(asyncStorageStore.size).toBe(0);
    expect(secureStoreState.size).toBe(0);
  });

  it("migrates a legacy plaintext connection string into SecureStore", async () => {
    asyncStorageStore.set(
      `self-sown:account:nwc:${PUBKEY_A}`,
      VALID_CONNECTION
    );
    const saved = await loadNwcConnection(PUBKEY_A);
    expect(saved?.connectionString).toBe(VALID_CONNECTION);
    // No plaintext copy survives the load.
    expect(asyncStorageStore.has(`self-sown:account:nwc:${PUBKEY_A}`)).toBe(
      false
    );
    expect(secureStoreState.get(`self-sown.nwc.${PUBKEY_A}`)).toBe(
      VALID_CONNECTION
    );
  });

  it("returns null info when the cached info JSON is corrupt", async () => {
    await saveNwcConnection(PUBKEY_A, VALID_CONNECTION, info);
    asyncStorageStore.set(`self-sown:account:nwc-info:${PUBKEY_A}`, "{nope");
    const saved = await loadNwcConnection(PUBKEY_A);
    expect(saved?.connectionString).toBe(VALID_CONNECTION);
    expect(saved?.info).toBeNull();
  });
});

describe("buildNwcRequestEvent", () => {
  const details = parseNwcConnectionString(VALID_CONNECTION);

  it.each([
    ["nip44_v2", "1.0"],
    ["nip04", "0.0"],
  ] as const)(
    "announces %s via encryption and legacy v tags",
    (encryption, version) => {
      const event = buildNwcRequestEvent(details, encryption, "get_info", {});
      expect(event.kind).toBe(23194);
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ["p", details.walletPubkey],
          ["v", version],
          ["encryption", encryption],
        ])
      );
    }
  );

  it.each(["nip44_v2", "nip04"] as const)(
    "lets a wallet reading the tags decrypt the %s request",
    (encryption) => {
      const event = buildNwcRequestEvent(details, encryption, "get_balance", {});
      // Simulate the wallet service: pick decryption from the request's own
      // encryption tag, exactly as Alby's NWC service does.
      const announced = event.tags.find((tag) => tag[0] === "encryption")?.[1];
      expect(announced).toBe(encryption);
      const plaintext =
        announced === "nip44_v2"
          ? nip44.v2.decrypt(
              event.content,
              nip44.v2.utils.getConversationKey(
                WALLET_SECRET,
                getPublicKey(Uint8Array.from(Buffer.from(CLIENT_SECRET_HEX, "hex")))
              )
            )
          : nip04.decrypt(
              WALLET_SECRET,
              getPublicKey(Uint8Array.from(Buffer.from(CLIENT_SECRET_HEX, "hex"))),
              event.content
            );
      expect(JSON.parse(plaintext)).toEqual({
        method: "get_balance",
        params: {},
      });
    }
  );
});

describe("selectNwcEncryption", () => {
  const baseEvent = { tags: [] as string[][] } as Event;

  it("prefers nip44_v2 when announced", () => {
    expect(
      selectNwcEncryption({
        ...baseEvent,
        tags: [["encryption", "nip04 nip44_v2"]],
      })
    ).toBe("nip44_v2");
  });

  it("falls back to nip04 when only nip04 is announced", () => {
    expect(
      selectNwcEncryption({ ...baseEvent, tags: [["encryption", "nip04"]] })
    ).toBe("nip04");
  });

  it("honors the legacy v tag and defaults to nip04", () => {
    expect(
      selectNwcEncryption({ ...baseEvent, tags: [["v", "1.0"]] })
    ).toBe("nip44_v2");
    expect(selectNwcEncryption(baseEvent)).toBe("nip04");
  });
});

describe("decryptNwcResponseContent", () => {
  const clientSecret = Uint8Array.from(Buffer.from(CLIENT_SECRET_HEX, "hex"));
  const clientPubkey = getPublicKey(clientSecret);

  function walletResponse(
    encryption: "nip44_v2" | "nip04",
    payload: unknown
  ) {
    const plaintext = JSON.stringify(payload);
    const content =
      encryption === "nip44_v2"
        ? nip44.v2.encrypt(
            plaintext,
            nip44.v2.utils.getConversationKey(WALLET_SECRET, clientPubkey)
          )
        : nip04.encrypt(WALLET_SECRET, clientPubkey, plaintext);
    return finalizeEvent(
      {
        kind: 23195,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", clientPubkey]],
        content,
      },
      WALLET_SECRET
    );
  }

  it.each(["nip44_v2", "nip04"] as const)(
    "round-trips a %s response",
    (encryption) => {
      const event = walletResponse(encryption, {
        result_type: "get_balance",
        result: { balance: 21000 },
      });
      const response = decryptNwcResponseContent(
        encryption,
        clientSecret,
        event
      );
      expect(response.result).toEqual({ balance: 21000 });
    }
  );

  it.each(["nip44_v2", "nip04"] as const)(
    "round-trips a %s error payload",
    (encryption) => {
      const event = walletResponse(encryption, {
        result_type: "get_balance",
        error: { code: "UNAUTHORIZED", message: "no permission" },
      });
      const response = decryptNwcResponseContent(
        encryption,
        clientSecret,
        event
      );
      expect(response.error?.code).toBe("UNAUTHORIZED");
    }
  );
});
