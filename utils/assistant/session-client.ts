/**
 * Client-side helper for the scoped assistant session tokens. One NIP-98
 * signature (one extension/bunker prompt) mints a short-lived bearer token
 * for a single scope; subsequent requests on that surface send the token
 * instead of signing per request.
 *
 * Returns null on any failure — callers fall back to per-request signing, so
 * nsec signers and older servers behave exactly as before.
 *
 * In-memory only by design: a fresh page load re-mints (one prompt).
 */
import type { NostrSigner } from "@/utils/nostr/signers/nostr-signer";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import type { AssistantSessionScope } from "@/utils/assistant/session-token";

export type ScopedSessionToken = { token: string; expiresAt: number };

export async function mintScopedSessionToken(
  signer: NostrSigner,
  scope: AssistantSessionScope
): Promise<ScopedSessionToken | null> {
  try {
    const url = `${window.location.origin}/api/assistant/session`;
    const body = JSON.stringify({ scope });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The scope rides in the body, so the NIP-98 payload hash covers it.
        Authorization: await createNip98AuthorizationHeader(
          signer,
          url,
          "POST",
          body
        ),
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (
      res.ok &&
      typeof data.token === "string" &&
      typeof data.expiresAt === "number"
    ) {
      return { token: data.token, expiresAt: data.expiresAt };
    }
  } catch {
    // fall through — caller falls back to per-request signing
  }
  return null;
}
