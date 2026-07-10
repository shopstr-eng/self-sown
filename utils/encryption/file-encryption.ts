import { nip19 } from "nostr-tools";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";

function buildEncryptedFile(
  encryptedData: unknown,
  originalFileName: string
): File {
  const jsonString = JSON.stringify(encryptedData);
  const encoder = new TextEncoder();
  const binaryData = encoder.encode(jsonString);
  const blob = new Blob([binaryData], { type: "application/octet-stream" });

  // Use .enc extension to indicate it's encrypted
  return new File(
    [blob],
    `encrypted-${originalFileName.replace(".pdf", ".enc")}`,
    { type: "application/octet-stream" }
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (data:application/pdf;base64,)
      const base64 = result.split(",")[1];
      resolve(base64 as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function encryptFileWithNip44(
  file: File,
  encryptionNpub: string,
  isSigned?: boolean,
  signer?: any
): Promise<File> {
  try {
    const base64Data = await fileToBase64(file);

    if (!isSigned) {
      // System-key encryption. The system private key never leaves the server:
      // the file is encrypted server-side and only the ciphertext is returned.
      // A NIP-98 signature proves the caller is an authenticated Nostr user.
      if (!signer) {
        throw new Error("No signer provided for server-side file encryption");
      }

      const body = JSON.stringify({
        fileBase64: base64Data,
        encryptionNpub,
        originalFileName: file.name,
        originalSize: file.size,
      });

      const authHeader = await createNip98AuthorizationHeader(
        signer,
        `${window.location.origin}/api/encryption/encrypt-file`,
        "POST",
        body
      );

      const response = await fetch("/api/encryption/encrypt-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body,
      });

      if (!response.ok) {
        throw new Error("Failed to encrypt file");
      }

      const { encryptedData } = await response.json();
      return buildEncryptedFile(encryptedData, file.name);
    }

    // Signed (peer-to-peer) path — uses the user's own signer and stays
    // fully client-side; the server never sees the plaintext or the key.
    if (!signer) {
      throw new Error("No signer provided for signed file encryption");
    }

    let sellerPubkey: string;
    if (encryptionNpub.startsWith("npub1")) {
      const { data } = nip19.decode(encryptionNpub);
      sellerPubkey = data as string;
    } else {
      sellerPubkey = encryptionNpub;
    }

    // Encrypt in chunks due to NIP-44 size limits (max ~65KB per message)
    const maxChunkSize = 60000;
    const encryptedChunks: string[] = [];
    for (let i = 0; i < base64Data.length; i += maxChunkSize) {
      const chunk = base64Data.slice(i, i + maxChunkSize);
      const encryptedChunk = await signer.encrypt(sellerPubkey, chunk);
      encryptedChunks.push(encryptedChunk);
    }

    const metadata = {
      totalChunks: encryptedChunks.length,
      originalFileName: file.name,
      originalSize: file.size,
      chunkSize: maxChunkSize,
    };
    const encryptedMetadata = await signer.encrypt(
      sellerPubkey,
      JSON.stringify(metadata)
    );

    const encryptedData = {
      header: "Encrypted Herdshare Agreement",
      metadata: encryptedMetadata,
      chunks: encryptedChunks,
      originalFileName: file.name,
      timestamp: new Date().toISOString(),
    };

    return buildEncryptedFile(encryptedData, file.name);
  } catch (error) {
    console.error("Error encrypting file:", error);
    throw new Error("Failed to encrypt file");
  }
}

export async function decryptFileWithNip44(
  encryptedData: string | ArrayBuffer,
  encryptionNpub: string,
  signer?: any
): Promise<Uint8Array> {
  try {
    // System-key decryption happens server-side so the private key never leaves
    // the server. A NIP-98 signature proves the caller is an authenticated user.
    if (!signer) {
      throw new Error("No signer provided for server-side file decryption");
    }

    const encryptedContent =
      typeof encryptedData === "string"
        ? encryptedData
        : new TextDecoder().decode(encryptedData);

    const body = JSON.stringify({ encryptedContent, encryptionNpub });

    const authHeader = await createNip98AuthorizationHeader(
      signer,
      `${window.location.origin}/api/encryption/decrypt-file`,
      "POST",
      body
    );

    const response = await fetch("/api/encryption/decrypt-file", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });

    if (!response.ok) {
      throw new Error("Failed to decrypt file");
    }

    const { base64 } = await response.json();

    // Clean up the base64 string - remove any whitespace or invalid characters
    const cleanBase64 = String(base64 ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
    if (cleanBase64.length === 0 || cleanBase64.length % 4 !== 0) {
      throw new Error("Invalid base64 data in encrypted content");
    }

    const binaryString = atob(cleanBase64);
    const uint8Array = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      uint8Array[i] = binaryString.charCodeAt(i);
    }
    return uint8Array;
  } catch (error) {
    console.error("Error decrypting file:", error);
    throw new Error("Failed to decrypt file");
  }
}
