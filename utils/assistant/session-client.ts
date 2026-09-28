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

/**
 * Invalidate every outstanding session token the seller holds, every scope
 * at once — the targeted kill switch for a suspected token leak (shared
 * screen, borrowed laptop) that doesn't require a global SESSION_SECRET
 * rotation. The server stamps "revoked before now"; the bearer preamble
 * rejects any token issued at or before the stamp.
 *
 * Returns true only when the server confirmed the revocation.
 */
export async function revokeAssistantSessionTokens(
  signer: NostrSigner
): Promise<boolean> {
  try {
    const url = `${window.location.origin}/api/assistant/session`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        // DELETE carries no body, so no payload hash is signed.
        Authorization: await createNip98AuthorizationHeader(
          signer,
          url,
          "DELETE"
        ),
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
