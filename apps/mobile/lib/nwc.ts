import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  finalizeEvent,
  nip04,
  nip44,
  SimplePool,
  type Event,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

// Mobile port of components/settings/nwc-section.tsx. The web uses the Alby
// SDK's NostrWebLNProvider; mobile speaks the same NIP-47 protocol directly
// over nostr-tools (already a proven dependency of the mobile app) instead of
// pulling in the web-oriented SDK.
//
// Storage follows the mobile pubkey-scoping rule, and the connection string
// is a spending credential so it goes to the OS keychain (SecureStore), never
// plaintext AsyncStorage — same treatment as the session itself. SecureStore
// keys only allow [A-Za-z0-9._-], so the pubkey suffix joins with "." instead
// of the AsyncStorage ":" convention. The cached wallet info holds no secret
// and stays in pubkey-scoped AsyncStorage.
const NWC_STRING_SECURE_PREFIX = "self-sown.nwc";
const NWC_INFO_STORAGE_PREFIX = "self-sown:account:nwc-info";
// Written only by the unreleased first cut of this feature; moved into
// SecureStore on first load, then deleted.
const LEGACY_ASYNCSTRING_PREFIX = "self-sown:account:nwc";

const NWC_PROTOCOL_PREFIX = "nostr+walletconnect://";
const NWC_INFO_EVENT_KIND = 13194;
const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;
const HEX_64 = /^[0-9a-f]{64}$/i;
// Same bounds as the Alby SDK so a dead wallet fails instead of hanging.
const NWC_INFO_TIMEOUT_MS = 10_000;
const NWC_REQUEST_TIMEOUT_MS = 10_000;

export type NwcEncryption = "nip44_v2" | "nip04";

export type NwcConnectionDetails = {
  walletPubkey: string;
  relays: string[];
  secret: string;
};

export type NwcWalletInfo = { alias?: string; methods: string[] } & Record<
  string,
  unknown
>;

export type NwcWalletSnapshot = {
  info: NwcWalletInfo;
  balanceSats: number | null;
};

export type SavedNwcConnection = {
  connectionString: string;
  info: NwcWalletInfo | null;
};

export function parseNwcConnectionString(raw: string): NwcConnectionDetails {
  const value = raw.trim();
  if (!value.startsWith(NWC_PROTOCOL_PREFIX)) {
    throw new Error(
      "Invalid Nostr Wallet Connect string. It must start with 'nostr+walletconnect://'"
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Nostr Wallet Connect string.");
  }
  const walletPubkey = url.hostname.toLowerCase();
  if (!HEX_64.test(walletPubkey)) {
    throw new Error("Invalid wallet public key in the connection string.");
  }
  const secret = url.searchParams.get("secret") ?? "";
  if (!HEX_64.test(secret)) {
    throw new Error(
      "Invalid or missing 'secret' parameter (must be 64 hex chars)."
    );
  }
  const relays = url.searchParams
    .getAll("relay")
    .filter((relay) => relay.startsWith("wss://") || relay.startsWith("ws://"));
  if (relays.length === 0) {
    throw new Error("Missing 'relay' parameter in the connection string.");
  }
  return { walletPubkey, relays, secret };
}

// Screen-friendly wrapper matching the other account-settings validators.
export function validateNwcConnectionString(value: string): string | null {
  if (!value.trim()) return "A connection string is required.";
  try {
    parseNwcConnectionString(value);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Invalid connection string.";
  }
}

// The wallet's kind:13194 info event announces supported encryption. NIP-47
// prefers NIP-44 v2; NIP-04 is the legacy default when nothing is announced.
export function selectNwcEncryption(infoEvent: Event): NwcEncryption {
  const encryptionTag = infoEvent.tags.find((tag) => tag[0] === "encryption");
  if (encryptionTag?.[1]) {
    const announced = encryptionTag[1].split(" ");
    return announced.includes("nip44_v2") ? "nip44_v2" : "nip04";
  }
  const versionTag = infoEvent.tags.find((tag) => tag[0] === "v");
  return versionTag?.[1]?.includes("1.0") ? "nip44_v2" : "nip04";
}

function encryptNwcPayload(
  encryption: NwcEncryption,
  secretKey: Uint8Array,
  walletPubkey: string,
  plaintext: string
): string {
  return encryption === "nip44_v2"
    ? nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(secretKey, walletPubkey)
      )
    : nip04.encrypt(secretKey, walletPubkey, plaintext);
}

export type NwcResponse = {
  result_type?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

// Exported for tests: the wallet→client half of the NIP-47 exchange.
export function decryptNwcResponseContent(
  encryption: NwcEncryption,
  secretKey: Uint8Array,
  event: Pick<Event, "pubkey" | "content">
): NwcResponse {
  const plaintext =
    encryption === "nip44_v2"
      ? nip44.v2.decrypt(
          event.content,
          nip44.v2.utils.getConversationKey(secretKey, event.pubkey)
        )
      : nip04.decrypt(secretKey, event.pubkey, event.content);
  return JSON.parse(plaintext) as NwcResponse;
}

function normalizeMethods(methods: unknown): string[] {
  return Array.isArray(methods)
    ? methods.filter((method): method is string => typeof method === "string")
    : [];
}

// Exported for tests: the client→wallet half of the NIP-47 exchange. The
// encryption/v tags are what tell the wallet service how to decrypt the
// content; without them Alby defaults to NIP-04 and cannot read a NIP-44
// payload (mirrors the Alby SDK, including its legacy "v" tag).
export function buildNwcRequestEvent(
  details: NwcConnectionDetails,
  encryption: NwcEncryption,
  method: string,
  params: Record<string, unknown>
): Event {
  const secretKey = hexToBytes(details.secret);
  return finalizeEvent(
    {
      kind: NWC_REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", details.walletPubkey],
        ["v", encryption === "nip44_v2" ? "1.0" : "0.0"],
        ["encryption", encryption],
      ],
      content: encryptNwcPayload(
        encryption,
        secretKey,
        details.walletPubkey,
        JSON.stringify({ method, params })
      ),
    },
    secretKey
  );
}

async function executeNwcRequest(
  pool: SimplePool,
  details: NwcConnectionDetails,
  encryption: NwcEncryption,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const secretKey = hexToBytes(details.secret);
  const request = buildNwcRequestEvent(details, encryption, method, params);

  const responsePromise = new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sub.close();
        reject(new Error(`The wallet did not answer ${method} in time.`));
      }, NWC_REQUEST_TIMEOUT_MS);
      const sub = pool.subscribeMany(
        details.relays,
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [details.walletPubkey],
          "#e": [request.id],
        },
        {
          onevent: (event) => {
            if (settled) return;
            let response: NwcResponse;
            try {
              response = decryptNwcResponseContent(
                encryption,
                secretKey,
                event
              );
            } catch {
              // Not addressed to us or undecryptable — keep waiting for the
              // real response until the timeout.
              return;
            }
            settled = true;
            clearTimeout(timer);
            sub.close();
            if (response.error) {
              reject(
                new Error(response.error.message ?? "Wallet request failed.")
              );
            } else {
              resolve(response.result ?? {});
            }
          },
        }
      );
      // Subscribe before publishing so a fast wallet can't answer into the
      // void. Publish failures surface via the timeout.
      for (const publishPromise of pool.publish(details.relays, request)) {
        publishPromise.catch(() => {});
      }
    }
  );
  return responsePromise;
}

// Connects to the wallet: fetches its info event, runs get_info, and reads
// the balance when the wallet supports get_balance (web section parity).
export async function fetchNwcWalletSnapshot(
  details: NwcConnectionDetails
): Promise<NwcWalletSnapshot> {
  const pool = new SimplePool();
  try {
    const infoEvent = await pool.get(
      details.relays,
      {
        kinds: [NWC_INFO_EVENT_KIND],
        authors: [details.walletPubkey],
        limit: 1,
      },
      { maxWait: NWC_INFO_TIMEOUT_MS }
    );
    if (!infoEvent) {
      throw new Error(
        "The wallet did not return its info event. Check the relay in the connection string."
      );
    }
    const encryption = selectNwcEncryption(infoEvent);
    const rawInfo = await executeNwcRequest(
      pool,
      details,
      encryption,
      "get_info",
      {}
    );
    const info: NwcWalletInfo = {
      ...rawInfo,
      methods: normalizeMethods(rawInfo.methods),
    };
    let balanceSats: number | null = null;
    if (info.methods.includes("get_balance")) {
      try {
        const balanceResult = await executeNwcRequest(
          pool,
          details,
          encryption,
          "get_balance",
          {}
        );
        if (typeof balanceResult.balance === "number") {
          // NIP-47 balances are millisats.
          balanceSats = balanceResult.balance / 1000;
        }
      } catch {
        balanceSats = null;
      }
    }
    return { info, balanceSats };
  } finally {
    pool.close(details.relays);
  }
}

export async function loadNwcConnection(
  pubkey: string
): Promise<SavedNwcConnection | null> {
  const legacyKey = `${LEGACY_ASYNCSTRING_PREFIX}:${pubkey}`;
  let connectionString = await SecureStore.getItemAsync(
    `${NWC_STRING_SECURE_PREFIX}.${pubkey}`
  );
  if (!connectionString) {
    // Migrate a plaintext credential written before SecureStore storage
    // landed, then make sure no plaintext copy survives.
    connectionString = await AsyncStorage.getItem(legacyKey);
    if (connectionString) {
      await SecureStore.setItemAsync(
        `${NWC_STRING_SECURE_PREFIX}.${pubkey}`,
        connectionString
      );
    }
  }
  await AsyncStorage.removeItem(legacyKey);
  if (!connectionString) return null;
  const rawInfo = await AsyncStorage.getItem(
    `${NWC_INFO_STORAGE_PREFIX}:${pubkey}`
  );
  let info: NwcWalletInfo | null = null;
  if (rawInfo) {
    try {
      const parsed = JSON.parse(rawInfo) as NwcWalletInfo;
      info = { ...parsed, methods: normalizeMethods(parsed.methods) };
    } catch {
      info = null;
    }
  }
  return { connectionString, info };
}

export async function saveNwcConnection(
  pubkey: string,
  connectionString: string,
  info: NwcWalletInfo
): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(
      `${NWC_STRING_SECURE_PREFIX}.${pubkey}`,
      connectionString
    ),
    AsyncStorage.setItem(
      `${NWC_INFO_STORAGE_PREFIX}:${pubkey}`,
      JSON.stringify(info)
    ),
  ]);
}

export async function clearNwcConnection(pubkey: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(`${NWC_STRING_SECURE_PREFIX}.${pubkey}`),
    AsyncStorage.removeItem(`${NWC_INFO_STORAGE_PREFIX}:${pubkey}`),
    AsyncStorage.removeItem(`${LEGACY_ASYNCSTRING_PREFIX}:${pubkey}`),
  ]);
}
