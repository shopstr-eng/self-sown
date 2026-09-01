import {
  decryptCredential,
  encryptCredential,
} from "@/utils/nostr/credential-encryption";

const CONTEXT = "milk-market:nip46:v1";

export type NIP46SignerCredentials = {
  type: "nip46";
  bunker: string;
  appPrivKey: string;
};

function validateBunkerUrl(bunker: string): string {
  const url = new URL(bunker);
  if (url.protocol !== "bunker:" || !/^[0-9a-f]{64}$/i.test(url.hostname)) {
    throw new Error("Invalid NIP-46 signer credentials.");
  }
  return bunker;
}

export async function encryptNIP46SignerCredentials(
  credentials: NIP46SignerCredentials,
  passphrase: string
): Promise<{ encryptedSigner: string; runtimeSigner: NIP46SignerCredentials }> {
  if (!/^[0-9a-f]{64}$/i.test(credentials.appPrivKey)) {
    throw new Error("Invalid NIP-46 signer credentials.");
  }
  const runtimeSigner = { ...credentials, bunker: validateBunkerUrl(credentials.bunker) };
  return {
    encryptedSigner: await encryptCredential(
      JSON.stringify({ version: 1, ...runtimeSigner }),
      passphrase,
      CONTEXT
    ),
    runtimeSigner,
  };
}

export async function decryptNIP46SignerCredentials(
  encryptedSigner: string,
  passphrase: string
): Promise<NIP46SignerCredentials> {
  try {
    const payload: unknown = JSON.parse(
      await decryptCredential(encryptedSigner, passphrase, CONTEXT)
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as any).version !== 1 ||
      typeof (payload as any).bunker !== "string" ||
      !/^[0-9a-f]{64}$/i.test((payload as any).appPrivKey)
    ) {
      throw new Error();
    }
    return {
      type: "nip46",
      // The bunker secret is a connection capability, not display metadata:
      // it must remain inside the authenticated encrypted payload.
      bunker: validateBunkerUrl((payload as any).bunker),
      appPrivKey: (payload as any).appPrivKey,
    };
  } catch {
    throw new Error("Incorrect passphrase or invalid NIP-46 connection.");
  }
}