import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  type KeyObject,
} from "node:crypto";

// --- Web Bot Auth: HTTP Message Signatures key directory ----------------------
// Implements the publishing half of Web Bot Auth
// (draft-meunier-web-bot-auth-architecture +
// draft-meunier-http-message-signatures-directory): we expose an Ed25519
// public-key directory at /.well-known/http-message-signatures-directory so
// agents/verifiers can discover the platform's signing key(s) and, in turn,
// agents have a canonical place to learn that Milk Market participates in
// verifiable, signature-based identity.
//
// Key source, in order of preference:
//   1. WEB_BOT_AUTH_ED25519_PRIVATE_KEY env — base64-encoded PKCS#8 DER (or a
//      full PEM block). RECOMMENDED for production so the published key is
//      stable across restarts and across horizontally-scaled instances.
//   2. Auto-generated, memoized per process. Lets the directory work out of the
//      box in dev/preview; the key is stable for the life of the process but
//      rotates on restart, so set the env var before relying on it in prod.

export type SignatureDirectoryJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  key_ops: ["verify"];
  // JOSE algorithm identifier for Ed25519 keys is "EdDSA" (RFC 8037). The
  // HTTP Message Signatures algorithm label is the separate lowercase
  // "ed25519" (RFC 9421), advertised in the discovery JSON, not here.
  alg: "EdDSA";
};

export type SignatureDirectory = {
  keys: SignatureDirectoryJwk[];
};

let cachedPublicKey: KeyObject | null = null;
let cachedSource: "env" | "generated" | null = null;

function decodePrivateKeyFromEnv(raw: string): KeyObject | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // PEM block provided directly.
  if (trimmed.includes("-----BEGIN")) {
    try {
      return createPrivateKey({ key: trimmed, format: "pem" });
    } catch {
      return null;
    }
  }

  // Otherwise treat it as base64-encoded PKCS#8 DER.
  try {
    const der = Buffer.from(trimmed, "base64");
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return null;
  }
}

function loadPublicKey(): KeyObject {
  if (cachedPublicKey) return cachedPublicKey;

  const envKey = process.env.WEB_BOT_AUTH_ED25519_PRIVATE_KEY;
  if (envKey) {
    const priv = decodePrivateKeyFromEnv(envKey);
    if (priv && priv.asymmetricKeyType === "ed25519") {
      cachedPublicKey = createPublicKey(priv);
      cachedSource = "env";
      return cachedPublicKey;
    }
    // Fall through to generation if the env value is malformed so the endpoint
    // still serves a valid directory instead of 500-ing.
    console.warn(
      "WEB_BOT_AUTH_ED25519_PRIVATE_KEY is set but could not be parsed as an Ed25519 PKCS#8 key; falling back to an ephemeral generated key."
    );
  }

  const { publicKey } = generateKeyPairSync("ed25519");
  cachedPublicKey = publicKey;
  cachedSource = "generated";
  return cachedPublicKey;
}

export function getSignatureKeySource(): "env" | "generated" {
  loadPublicKey();
  return cachedSource ?? "generated";
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// RFC 7638 JWK thumbprint for an Ed25519 (OKP) public key. The canonical form
// includes only the required members in lexicographic order: crv, kty, x.
function calculateOkpThumbprint(crv: string, x: string): string {
  const canonical = JSON.stringify({ crv, kty: "OKP", x });
  return base64url(createHash("sha256").update(canonical).digest());
}

// Builds the Web Bot Auth signature directory (a JWK Set of public verification
// keys). `kid` is the RFC 7638 JWK thumbprint, which is what Web Bot Auth
// verifiers use to bind a request's signature to a directory entry.
export async function getSignatureDirectory(): Promise<SignatureDirectory> {
  const publicKey = loadPublicKey();
  const jwk = publicKey.export({ format: "jwk" });

  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("Unexpected key type for Web Bot Auth signature directory");
  }

  const kid = calculateOkpThumbprint(jwk.crv, jwk.x);

  return {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: jwk.x,
        kid,
        use: "sig",
        key_ops: ["verify"],
        alg: "EdDSA",
      },
    ],
  };
}

// Test/maintenance helper: forget any memoized key so a changed env var is
// picked up without restarting the process.
export function __resetSignatureKeyCache(): void {
  cachedPublicKey = null;
  cachedSource = null;
}
