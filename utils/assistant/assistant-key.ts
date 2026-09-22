// Server-managed MCP API key for the in-app seller assistant.
//
// Each Pro seller gets one dedicated full_access key row ("Self-sown
// Assistant (in-app chat)"). The raw key generated at creation is discarded
// on purpose: nothing outside the server ever needs it, so there is no
// bearer credential in the wild to leak. When the chat route needs to speak
// to /api/mcp it ROTATES the row to a fresh raw key (key_prefix + key_hash
// update) and caches it per process; the row is inert for external use
// either way because the raw value never leaves the server.
//
// Write tools sign Nostr events via getAgentSigner(row), which needs
// row.encrypted_nsec. If the seller already configured agent signing on any
// other full_access key, we copy the encrypted blob across (same encryption
// key — no decrypt/re-encrypt needed). Otherwise writes stay disabled until
// the seller pastes their nsec in the assistant setup card.

import { getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";
import { getDbPool } from "@/utils/db/db-service";
import {
  createApiKey,
  generateApiKey,
  hashApiKey,
  initializeApiKeysTable,
  updateApiKeyNsec,
  type ApiKeyRecord,
} from "@/utils/mcp/auth";
import { encryptNsec } from "@/utils/mcp/nostr-signing";

export const ASSISTANT_KEY_NAME = "Self-sown Assistant (in-app chat)";

let tablesReady = false;

export async function ensureAssistantTables(): Promise<void> {
  if (!tablesReady) {
    await initializeApiKeysTable();
    tablesReady = true;
  }
}

export async function getOrCreateAssistantKey(
  pubkey: string
): Promise<ApiKeyRecord> {
  await ensureAssistantTables();
  const pool = getDbPool();
  const existing = await pool.query(
    `SELECT * FROM mcp_api_keys
     WHERE pubkey = $1 AND name = $2 AND is_active = TRUE
     ORDER BY (encrypted_nsec IS NOT NULL) DESC, id ASC
     LIMIT 1`,
    [pubkey, ASSISTANT_KEY_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0] as ApiKeyRecord;

  // Raw key intentionally discarded — see module comment.
  const { record } = await createApiKey(
    ASSISTANT_KEY_NAME,
    pubkey,
    "full_access"
  );
  return record;
}

// --- Raw-key cache + single-flight rotation -------------------------------

const rawKeyByPubkey = new Map<string, string>();
const rotationByPubkey = new Map<string, Promise<string>>();

// Drop the cached raw key (e.g. after the seller revokes the assistant row in
// settings, or another process rotated it). The next getAssistantRawKey call
// rotates a fresh one.
export function invalidateAssistantRawKey(pubkey: string): void {
  rawKeyByPubkey.delete(pubkey);
}

export async function getAssistantRawKey(
  pubkey: string,
  row?: ApiKeyRecord
): Promise<string> {
  const cached = rawKeyByPubkey.get(pubkey);
  if (cached) return cached;
  const inFlight = rotationByPubkey.get(pubkey);
  if (inFlight) return inFlight;

  const rotation = (async (): Promise<string> => {
    let record = row ?? (await getOrCreateAssistantKey(pubkey));
    for (let attempt = 0; attempt < 2; attempt++) {
      const { key, prefix } = generateApiKey();
      const pool = getDbPool();
      const result = await pool.query(
        `UPDATE mcp_api_keys
         SET key_prefix = $1, key_hash = $2, last_used_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND pubkey = $4 AND is_active = TRUE
         RETURNING id`,
        [prefix, hashApiKey(key), record.id, pubkey]
      );
      if ((result.rowCount ?? 0) > 0) {
        rawKeyByPubkey.set(pubkey, key);
        return key;
      }
      // Row was deactivated mid-flight (e.g. tier lapse) — recreate and retry
      // exactly once before giving up loudly.
      record = await getOrCreateAssistantKey(pubkey);
    }
    throw new Error("Could not activate the assistant MCP key");
  })().finally(() => {
    rotationByPubkey.delete(pubkey);
  });

  rotationByPubkey.set(pubkey, rotation);
  return rotation;
}

// --- Signing capability ----------------------------------------------------

export async function getAssistantSigningState(
  pubkey: string,
  row: ApiKeyRecord
): Promise<boolean> {
  if (row.encrypted_nsec) return true;

  // Reuse agent signing the seller already configured for external MCP use —
  // nobody should have to paste their nsec twice.
  const pool = getDbPool();
  const donor = await pool.query(
    `SELECT encrypted_nsec FROM mcp_api_keys
     WHERE pubkey = $1 AND is_active = TRUE AND permissions = 'full_access'
       AND encrypted_nsec IS NOT NULL AND id <> $2
     ORDER BY id ASC
     LIMIT 1`,
    [pubkey, row.id]
  );
  const encryptedNsec = donor.rows[0]?.encrypted_nsec as string | undefined;
  if (!encryptedNsec) return false;

  await updateApiKeyNsec(row.id, pubkey, encryptedNsec, "full_access");
  return true;
}

export async function provisionAssistantSigning(
  pubkey: string,
  nsec: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = (nsec || "").trim();
  let derivedPubkey: string;
  try {
    if (trimmed.startsWith("nsec1")) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec") {
        return { ok: false, error: "Invalid nsec format." };
      }
      derivedPubkey = getPublicKey(decoded.data as Uint8Array);
    } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      derivedPubkey = getPublicKey(hexToBytes(trimmed));
    } else {
      return {
        ok: false,
        error:
          "Invalid nsec format. Provide an nsec1... bech32 key or 64-char hex private key.",
      };
    }
  } catch {
    return { ok: false, error: "Invalid nsec format." };
  }

  if (derivedPubkey !== pubkey) {
    return {
      ok: false,
      error: "That secret key does not match your signed-in account.",
    };
  }

  const row = await getOrCreateAssistantKey(pubkey);
  const updated = await updateApiKeyNsec(
    row.id,
    pubkey,
    encryptNsec(trimmed),
    "full_access"
  );
  if (!updated) {
    return { ok: false, error: "Could not save the signing key. Try again." };
  }
  return { ok: true };
}
