/**
 * Shared derivation of a seller's display Nostr address (NIP-05) from a
 * nostr.json `names` map.
 *
 * Both the seller-side settings (custom-domain-section) and the buyer-side
 * storefront footer MUST use this helper so the address a seller sees can
 * never drift from the address buyers see.
 *
 * Tie-break contract (relies on pages/api/storefront/nostr-json.ts): the
 * endpoint inserts the exact-case username before its lower-cased alias, so
 * the FIRST key whose value matches the pubkey is the canonical display
 * form. Matching is case-insensitive on the value; the key is used verbatim.
 */

export interface Nip05AddressInput {
  /** The `names` map from a /.well-known/nostr.json document. */
  names: Record<string, string>;
  /** Hex pubkey to find an address for (matched case-insensitively). */
  pubkey: string;
  /** Host for the address's domain part (trimmed + lower-cased here). */
  host: string;
}

/**
 * Returns `name@host` for the first `names` entry pointing at `pubkey`, or
 * null when the pubkey isn't named or the host/inputs are unusable.
 */
export function nip05AddressFromNames({
  names,
  pubkey,
  host,
}: Nip05AddressInput): string | null {
  const cleanHost = host.trim().toLowerCase();
  if (!cleanHost || !pubkey) return null;
  const name = Object.keys(names ?? {}).find(
    (k) => names[k]?.toLowerCase() === pubkey.toLowerCase()
  );
  return name ? `${name}@${cleanHost}` : null;
}
