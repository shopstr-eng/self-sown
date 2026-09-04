// SERVER-ONLY adapter over ./token-decode: a token's embedded mint URL is
// attacker-controlled, so the fallback keyset fetch goes through the SSRF
// guard (scheme/port validation, public-IP check, pinned DNS).
//
// utils/url-safety imports node-only modules (dns/promises, undici) — never
// import THIS module from client-reachable code, or the browser bundle tries
// to compile them. Client decodes use ./token-decode directly (plain fetch).

import type { Token } from "@cashu/cashu-ts";
import { safeFetch } from "@/utils/url-safety";
import { decodeTokenWithKeysets as decodeWithPlainFetch } from "./token-decode";

const guardedKeysetFetch = (url: string): Promise<Response> =>
  safeFetch(url, { accept: "application/json" });

export function decodeTokenWithKeysets(
  token: string,
  mintUrl?: string
): Promise<Token> {
  return decodeWithPlainFetch(token, mintUrl, guardedKeysetFetch);
}
