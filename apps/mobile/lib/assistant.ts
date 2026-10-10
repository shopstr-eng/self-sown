import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "@/lib/api-base-url";
// Mirrors the web assistant contract: NIP-98 HTTP auth (kind 27235, header
// "Nostr <base64(json)>") against /api/assistant/* — see
// utils/nostr/nip98-auth.ts and pages/api/assistant/*.
import { createNip98AuthorizationHeader } from "@/lib/nip98";

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
