const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type Envelope = {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
};

function crypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure credential encryption is unavailable.");
  }
  return globalThis.crypto;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid encrypted credential data.");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function buffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function key(passphrase: string, salt: Uint8Array, usages: KeyUsage[]) {
  if (passphrase.trim().length < 12) {
    throw new Error("Passphrase must be at least 12 characters.");
  }
  const webCrypto = crypto();
  const material = await webCrypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase.trim()),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return webCrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: buffer(salt),
      iterations: ITERATIONS,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function encryptCredential(
  plaintext: string,
  passphrase: string,
  context: string
): Promise<string> {
  const webCrypto = crypto();
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: buffer(iv),
      additionalData: buffer(encoder.encode(context)),
    },
    await key(passphrase, salt, ["encrypt"]),
    encoder.encode(plaintext)
  );
  return JSON.stringify({
    version: 1,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  } satisfies Envelope);
}

export async function decryptCredential(
  encrypted: string,
  passphrase: string,
  context: string
): Promise<string> {
  const envelope: unknown = JSON.parse(encrypted);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    (envelope as Partial<Envelope>).version !== 1 ||
    typeof (envelope as Partial<Envelope>).salt !== "string" ||
    typeof (envelope as Partial<Envelope>).iv !== "string" ||
    typeof (envelope as Partial<Envelope>).ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted credential data.");
  }
  const value = envelope as Envelope;
  const salt = bytes(value.salt);
  const iv = bytes(value.iv);
  const ciphertext = bytes(value.ciphertext);
  const plaintext = await crypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buffer(iv),
      additionalData: buffer(encoder.encode(context)),
    },
    await key(passphrase, salt, ["decrypt"]),
    buffer(ciphertext)
  );
  return decoder.decode(plaintext);
}