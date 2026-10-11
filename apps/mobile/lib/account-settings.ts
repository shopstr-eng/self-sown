import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SellerSession } from "@self-sown/domain";
import {
  publishSellerBlossomServers,
  publishSellerRelayList,
  publishSellerWalletMints,
} from "@self-sown/nostr";

import { getApiBaseUrl } from "./api-base-url";

// Mobile port of pages/settings/account.tsx. The web page persists these
// preferences in localStorage; the mobile app mirrors them in AsyncStorage —
// scoped per seller pubkey, because several seller accounts can sign in on
// the same device and one account must never load (or worse, publish)
// another account's mints, relays, or Blossom servers. Relay lists
// additionally feed back into the SellerSession (which drives publish relay
// selection), handled by the screen via saveSession.
const MINTS_STORAGE_PREFIX = "self-sown:account:mints";
const READ_RELAYS_STORAGE_PREFIX = "self-sown:account:read-relays";
const WRITE_RELAYS_STORAGE_PREFIX = "self-sown:account:write-relays";
const BLOSSOM_SERVERS_STORAGE_PREFIX = "self-sown:account:blossom-servers";

// Unscoped keys written only by the unreleased first cut of this feature.
// Their owner is unknowable, so they are deleted on load rather than migrated
// to whichever account happens to sign in next.
const LEGACY_UNSCOPED_KEYS = [
  MINTS_STORAGE_PREFIX,
  READ_RELAYS_STORAGE_PREFIX,
  WRITE_RELAYS_STORAGE_PREFIX,
  BLOSSOM_SERVERS_STORAGE_PREFIX,
];

const MAX_URL_LENGTH = 500;

export type RelayLists = {
  all: string[];
  read: string[];
  write: string[];
};

export type AccountPreferences = {
  mints: string[];
  readRelays: string[];
  writeRelays: string[];
  blossomServers: string[];
};

async function readStringList(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item !== ""
    );
  } catch {
    return [];
  }
}

async function writeStringList(key: string, values: string[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(values));
}

async function clearLegacyUnscopedKeys(): Promise<void> {
  await Promise.all(
    LEGACY_UNSCOPED_KEYS.map((key) => AsyncStorage.removeItem(key))
  );
}

// The "all" relay list initializes from the session (set at sign-in); the
// read/write-only lists are settings-only and live in AsyncStorage.
export async function loadAccountPreferences(
  session: SellerSession
): Promise<AccountPreferences> {
  const pubkey = session.pubkey;
  await clearLegacyUnscopedKeys();
  const [mints, readRelays, storedWriteRelays, blossomServers] =
    await Promise.all([
      readStringList(`${MINTS_STORAGE_PREFIX}:${pubkey}`),
      readStringList(`${READ_RELAYS_STORAGE_PREFIX}:${pubkey}`),
      readStringList(`${WRITE_RELAYS_STORAGE_PREFIX}:${pubkey}`),
      readStringList(`${BLOSSOM_SERVERS_STORAGE_PREFIX}:${pubkey}`),
    ]);

  return {
    mints,
    readRelays,
    // The write-only list comes ONLY from explicitly saved settings. Session
    // writeRelays are publish targets (a fresh sign-in sets them equal to
    // relays), not a NIP-65 write-only list — falling back to them would show
    // every relay twice and re-tag shared relays as write-only on publish.
    writeRelays: storedWriteRelays,
    blossomServers,
  };
}

async function persistMints(pubkey: string, mints: string[]): Promise<void> {
  await writeStringList(`${MINTS_STORAGE_PREFIX}:${pubkey}`, mints);
}

async function persistRelayLists(
  pubkey: string,
  lists: Pick<RelayLists, "read" | "write">
): Promise<void> {
  await Promise.all([
    writeStringList(`${READ_RELAYS_STORAGE_PREFIX}:${pubkey}`, lists.read),
    writeStringList(`${WRITE_RELAYS_STORAGE_PREFIX}:${pubkey}`, lists.write),
  ]);
}

async function persistBlossomServers(
  pubkey: string,
  servers: string[]
): Promise<void> {
  await writeStringList(`${BLOSSOM_SERVERS_STORAGE_PREFIX}:${pubkey}`, servers);
}

export function validateRelayUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "A relay URL is required.";
  if (trimmed.length > MAX_URL_LENGTH)
    return `This input exceeds max length of ${MAX_URL_LENGTH}.`;
  if (!/^(wss:\/\/|ws:\/\/)/.test(trimmed))
    return "Invalid relay URL, must start with wss:// or ws://.";
  return null;
}

export function validateMintUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "A mint URL is required.";
  if (trimmed.length > MAX_URL_LENGTH)
    return `This input exceeds max length of ${MAX_URL_LENGTH}.`;
  if (!/^(https:\/\/|http:\/\/)/.test(trimmed))
    return "Invalid mint URL, must start with https:// or http://.";
  return null;
}

export function validateBlossomServerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "A Blossom server URL is required.";
  if (trimmed.length > MAX_URL_LENGTH)
    return `This input exceeds max length of ${MAX_URL_LENGTH}.`;
  if (!/^(https:\/\/|http:\/\/)/.test(trimmed))
    return "Invalid Blossom server URL, must start with https:// or http://.";
  return null;
}

// The active mint is always the first list entry; setting a mint active moves
// it to the front, mirroring the web's replaceMint.
export function moveMintToFront(mints: string[], mint: string): string[] {
  return [mint, ...mints.filter((existing) => existing !== mint)];
}

// Web parity: a mint is only accepted if its /keys endpoint answers.
export async function verifyMintReachable(mint: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${mint.replace(/\/+$/, "")}/keys`);
  } catch {
    throw new Error(
      `Failed to add mint! Could not fetch keys from ${mint}/keys.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to add mint! Could not fetch keys from ${mint}/keys.`
    );
  }
}

// Web parity: adding a Blossom server probes /upload and rejects a 404.
export async function verifyBlossomServerReachable(
  server: string
): Promise<void> {
  const url = new URL("/upload", server);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(
      `Failed to add Blossom server! ${server} was unable to connect.`
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Failed to add Blossom server! ${server} was unable to connect.`
    );
  }
}

export async function publishRelayLists(
  session: SellerSession,
  lists: RelayLists
): Promise<void> {
  await publishSellerRelayList({
    baseUrl: getApiBaseUrl(),
    session,
    relays: lists,
  });
  await persistRelayLists(session.pubkey, {
    read: lists.read,
    write: lists.write,
  });
}

export async function publishBlossomServers(
  session: SellerSession,
  servers: string[]
): Promise<void> {
  await publishSellerBlossomServers({
    baseUrl: getApiBaseUrl(),
    session,
    servers,
  });
  await persistBlossomServers(session.pubkey, servers);
}

export async function publishMints(
  session: SellerSession,
  mints: string[]
): Promise<void> {
  await publishSellerWalletMints({
    baseUrl: getApiBaseUrl(),
    session,
    mints,
  });
  await persistMints(session.pubkey, mints);
}
