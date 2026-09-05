// Shared cashu token decoding that tolerates newer mints.
//
// Newer Nutshell mints issue "v2" keyset IDs (0x01-prefixed). cashu-ts maps
// those at decode time, so getDecodedToken(token, []) throws "short keyset ID
// v2…" for their tokens unless the mint's keyset ids are supplied. On that
// specific error, fetch the mint's keyset list and retry. Cached per mint;
// failures are never cached. When the caller can't supply the mint URL, it is
// read from the token envelope via getTokenMetadata, which parses the token
// WITHOUT mapping keyset IDs.
//
// This module must stay CLIENT-SAFE: server call sites (which need an
// SSRF-guarded fetch for the attacker-controlled mint URL) go through
// ./token-decode-server instead of importing node-only guards here.

import { getDecodedToken, getTokenMetadata, type Token } from "@cashu/cashu-ts";

// Fetch implementation for the keyset-list request. Defaults to global fetch;
// server callers pass an SSRF-guarded one (see ./token-decode-server).
export type KeysetFetch = (url: string) => Promise<Response>;

// The global must be dereferenced lazily: a bare `= fetch` default parameter
// is evaluated on EVERY call (even when the retry path never runs), which
// throws ReferenceError in client environments without a fetch global (jsdom).
const defaultFetch: KeysetFetch = (url) => fetch(url);

const mintKeysetIdCache = new Map<string, Promise<string[]>>();

export function fetchMintKeysetIds(
  mintUrl: string,
  fetchFn: KeysetFetch = defaultFetch
): Promise<string[]> {
  let pending = mintKeysetIdCache.get(mintUrl);
  if (!pending) {
    pending = (async () => {
      const response = await fetchFn(`${mintUrl}/v1/keysets`);
      if (!response.ok) {
        throw new Error(`Failed to fetch keysets from ${mintUrl}`);
      }
      const body = await response.json();
      const ids = (body?.keysets ?? [])
        .map((keyset: { id?: unknown }) => keyset?.id)
        .filter((id: unknown): id is string => typeof id === "string");
      if (ids.length === 0) {
        throw new Error(`Mint ${mintUrl} returned no keysets`);
      }
      return ids;
    })();
    mintKeysetIdCache.set(mintUrl, pending);
    // Never cache a failure: a transient mint outage must not poison decodes.
    pending.catch(() => mintKeysetIdCache.delete(mintUrl));
  }
  return pending;
}

/**
 * Decode a cashu token, tolerating v2 keyset IDs: on the short-keyset-id
 * error, fetch the mint's keyset list and retry. Pass mintUrl when the caller
 * knows it (skips the envelope metadata parse); otherwise the mint is read
 * from the token itself. Any other decode error is rethrown unchanged.
 */
export async function decodeTokenWithKeysets(
  token: string,
  mintUrl?: string,
  fetchFn: KeysetFetch = defaultFetch
): Promise<Token> {
  try {
    return getDecodedToken(token, []);
  } catch (error) {
    const isShortKeysetIdError =
      error instanceof Error && /short keyset id/i.test(error.message);
    if (!isShortKeysetIdError) throw error;
    let mint = mintUrl;
    if (!mint) {
      try {
        mint = getTokenMetadata(token).mint;
      } catch {
        throw error;
      }
    }
    if (!mint) throw error;
    return getDecodedToken(token, await fetchMintKeysetIds(mint, fetchFn));
  }
}
