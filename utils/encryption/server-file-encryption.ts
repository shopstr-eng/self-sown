import { nip44, nip19 } from "nostr-tools";

const MAX_CHUNK_SIZE = 60000;

function decodeNsecToPrivKey(nsec: string): Uint8Array {
  if (!nsec.startsWith("nsec")) {
    throw new Error("Invalid encryption key format");
  }
  const { data } = nip19.decode(nsec);
  return data as Uint8Array;
}

/**
 * Returns the private key(s) used for system (non-signed) agreement-file crypto,
 * newest first. A dedicated FILE_ENCRYPTION_NSEC (when configured) is preferred so
 * the file-encryption key can be rotated independently of the server's Nostr DM
 * identity (ENCRYPTION_NSEC). The DM identity is kept as a decrypt fallback so any
 * files encrypted before the split still open. These keys never leave the server.
 */
function getFileEncryptionPrivKeys(): Uint8Array[] {
  const fileNsec = process.env["FILE_ENCRYPTION_NSEC"];
  const serverNsec = process.env["ENCRYPTION_NSEC"];

  const keys: Uint8Array[] = [];
  if (fileNsec) keys.push(decodeNsecToPrivKey(fileNsec));
  if (serverNsec) keys.push(decodeNsecToPrivKey(serverNsec));

  if (keys.length === 0) {
    throw new Error("Encryption key not configured");
  }
  return keys;
}

function npubToPubkey(encryptionNpub: string): string {
  if (encryptionNpub.startsWith("npub1")) {
    const { data } = nip19.decode(encryptionNpub);
    return data as string;
  }
  return encryptionNpub;
}

export interface EncryptedAgreementData {
  header: string;
  metadata: string;
  chunks: string[];
  originalFileName: string;
  timestamp: string;
}

export function encryptAgreementFile(
  base64Data: string,
  encryptionNpub: string,
  originalFileName: string,
  originalSize: number
): EncryptedAgreementData {
  const primaryKey = getFileEncryptionPrivKeys()[0]!;
  const pubkey = npubToPubkey(encryptionNpub);
  const conversationKey = nip44.getConversationKey(primaryKey, pubkey);

  const encryptedChunks: string[] = [];
  for (let i = 0; i < base64Data.length; i += MAX_CHUNK_SIZE) {
    const chunk = base64Data.slice(i, i + MAX_CHUNK_SIZE);
    encryptedChunks.push(nip44.encrypt(chunk, conversationKey));
  }

  const metadata = {
    totalChunks: encryptedChunks.length,
    originalFileName,
    originalSize,
    chunkSize: MAX_CHUNK_SIZE,
  };
  const encryptedMetadata = nip44.encrypt(
    JSON.stringify(metadata),
    conversationKey
  );

  return {
    header: "Encrypted Herdshare Agreement",
    metadata: encryptedMetadata,
    chunks: encryptedChunks,
    originalFileName,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Parses stored encrypted content into its encrypted chunks. Handles both the
 * current JSON (binary) format and the legacy text-based format.
 */
export function parseEncryptedContent(content: string): { chunks: string[] } {
  // Current JSON (binary) format
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.chunks)) {
      return { chunks: parsed.chunks as string[] };
    }
  } catch {
    // Not JSON — fall through to the legacy text format.
  }

  // Legacy text-based format
  const lines = content.split("\n");
  const metadataLine = lines.find((line) => line.startsWith("Metadata: "));
  const chunkLines = lines.filter((line) => line.startsWith("Chunk-"));

  if (!metadataLine || chunkLines.length === 0) {
    throw new Error("Invalid encrypted file format");
  }

  const chunks: string[] = [];
  for (let i = 0; i < chunkLines.length; i++) {
    const chunkLine = chunkLines.find((line) =>
      line.startsWith(`Chunk-${i}: `)
    );
    if (!chunkLine) {
      throw new Error(`Missing chunk ${i}`);
    }
    chunks.push(chunkLine.replace(`Chunk-${i}: `, ""));
  }
  return { chunks };
}

export function decryptAgreementFile(
  chunks: string[],
  encryptionNpub: string
): string {
  const keys = getFileEncryptionPrivKeys();
  const pubkey = npubToPubkey(encryptionNpub);

  let lastError: unknown;
  for (const key of keys) {
    try {
      const conversationKey = nip44.getConversationKey(key, pubkey);
      let decryptedBase64 = "";
      for (let i = 0; i < chunks.length; i++) {
        decryptedBase64 += nip44.decrypt(chunks[i]!, conversationKey);
      }
      return decryptedBase64;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Failed to decrypt agreement file");
}
