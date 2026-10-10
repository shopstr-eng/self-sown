import * as ExpoCrypto from "expo-crypto";
import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "@/lib/api-base-url";

// Mirrors the web assistant contract: NIP-98 HTTP auth (kind 27235, header
// "Nostr <base64(json)>") against /api/assistant/* — see
// utils/nostr/nip98-auth.ts and pages/api/assistant/*.
const NIP98_KIND = 27235;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(value: string): string {
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

async function createNip98AuthorizationHeader(
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

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

// Mirrors isProEntitled in utils/pro/membership-status.ts.
export function isMembershipEntitled(status: string | undefined): boolean {
  return status === "trialing" || status === "active" || status === "grace";
}

export async function getMembershipStatus(
  pubkey: string
): Promise<{ status?: string }> {
  const response = await fetch(
    `${getApiBaseUrl()}/api/pro/status?pubkey=${pubkey}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Membership status could not be loaded.")
    );
  }
  return (await response.json()) as { status?: string };
}

export async function getAssistantWritesEnabled(
  session: SellerSession
): Promise<boolean> {
  const url = `${getApiBaseUrl()}/api/assistant/setup`;
  const response = await fetch(url, {
    headers: {
      Authorization: await createNip98AuthorizationHeader(session, url, "GET"),
    },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        "Assistant setup state could not be loaded."
      )
    );
  }
  const data = (await response.json()) as { writesEnabled?: boolean };
  return Boolean(data.writesEnabled);
}

export async function enableAssistantWrites(
  session: SellerSession
): Promise<void> {
  const url = `${getApiBaseUrl()}/api/assistant/setup`;
  // The mobile session already holds the seller's key, so enabling writes is
  // one tap instead of the web's paste-the-nsec form.
  const body = JSON.stringify({ nsec: session.nsec });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createNip98AuthorizationHeader(
        session,
        url,
        "POST",
        body
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Write actions could not be enabled.")
    );
  }
}

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAction {
  tool: string;
  ok: boolean;
  detail: string;
  label?: {
    trackingCode: string | null;
    trackingUrl: string | null;
    labelUrl: string;
    rate: number;
    currency: string;
    carrier: string;
    service: string;
  };
}

export interface AssistantChatResult {
  reply: string;
  actions: AssistantAction[];
  writesEnabled: boolean;
}

export async function sendAssistantChat(
  session: SellerSession,
  messages: AssistantChatMessage[]
): Promise<AssistantChatResult> {
  const url = `${getApiBaseUrl()}/api/assistant/chat`;
  const body = JSON.stringify({ messages, stallPubkey: session.pubkey });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createNip98AuthorizationHeader(
        session,
        url,
        "POST",
        body
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The assistant request failed.")
    );
  }
  const data = (await response.json()) as {
    reply?: string;
    actions?: AssistantAction[];
    writesEnabled?: boolean;
  };
  return {
    reply: data.reply || "Done.",
    actions: Array.isArray(data.actions) ? data.actions : [],
    writesEnabled: Boolean(data.writesEnabled),
  };
}
