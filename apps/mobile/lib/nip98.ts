import * as ExpoCrypto from "expo-crypto";
import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

// NIP-98 HTTP auth (kind 27235, header "Nostr <base64(json)>") — mirrors
// utils/nostr/nip98-auth.ts on the web.
const NIP98_KIND = 27235;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : null;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : null;
    output += BASE64_ALPHABET[a >> 2]!;
    output += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    output +=
      b === null ? "=" : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    output += c === null ? "=" : BASE64_ALPHABET[c & 0x3f]!;
  }
  return output;
}

export async function createNip98AuthorizationHeader(
  session: SellerSession,
  url: string,
  method: "GET" | "POST",
  body?: string
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method],
  ];
  if (body !== undefined) {
    const digest = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      body
    );
    tags.push(["payload", digest]);
  }
  const authEvent = signEventTemplate(session, {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  });
  return `Nostr ${toBase64(JSON.stringify(authEvent))}`;
}
