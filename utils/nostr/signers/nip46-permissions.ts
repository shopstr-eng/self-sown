// Explicit, least-privilege NIP-46 permitted-methods list.
//
// The connect request tells the remote signer (bunker) exactly which signing
// operations this app may request — nothing more. Escrow commitment signing
// is a SEPARATE list that is only appended when the escrow feature flag is
// on, so a deployment that has not enabled escrow never asks the bunker for
// the extra kind.

import {
  ESCROW_ACTION_KIND,
  ESCROW_COMMITMENT_KIND,
} from "@/utils/cashu/escrow-commitment";

/**
 * Baseline permissions required by the existing app surface:
 *  - sign_event:0        profile metadata
 *  - sign_event:5        deletion requests
 *  - sign_event:13       gift-wrap seal
 *  - sign_event:1059     gift wrap
 *  - sign_event:1111     comments/replies
 *  - sign_event:4550     community approval
 *  - sign_event:7375/7376 Cashu wallet token + spending history
 *  - sign_event:10002    relay list
 *  - sign_event:17375    wallet-connect / encrypted key material
 *  - kind:30019          storefront config (legacy form retained for bunker
 *                      compatibility; sign_event:30019 is implied by it)
 *  - sign_event:30402    product listings
 *  - sign_event:30405/30406  community / community definition
 *  - sign_event:31555    reviews
 *  - sign_event:31989/31990  app recommendation / handler info
 *  - sign_event:34550    community definition (NIP-72)
 *  - get_public_key, nip44_encrypt, nip44_decrypt
 */
export const NIP46_BASE_PERMITTED_METHODS: readonly string[] = [
  "sign_event:0",
  "sign_event:5",
  "sign_event:13",
  "sign_event:1059",
  "sign_event:1111",
  "sign_event:4550",
  "sign_event:7375",
  "sign_event:7376",
  "sign_event:10002",
  "sign_event:17375",
  "kind:30019",
  "sign_event:30402",
  "sign_event:30405",
  "sign_event:30406",
  "sign_event:31555",
  "sign_event:31989",
  "sign_event:31990",
  "sign_event:34550",
  "get_public_key",
  "nip44_encrypt",
  "nip44_decrypt",
];

/** Escrow-only permissions, appended solely when escrow is enabled. */
export const NIP46_ESCROW_PERMITTED_METHODS: readonly string[] = [
  `sign_event:${ESCROW_COMMITMENT_KIND}`,
  // Buyer-signed refund trigger (post-expiry). Same flag gate as the
  // commitment kind — a deployment without escrow never requests either.
  `sign_event:${ESCROW_ACTION_KIND}`,
];

export function buildNip46PermittedMethods(options?: {
  escrowEnabled?: boolean;
}): string {
  const methods = [...NIP46_BASE_PERMITTED_METHODS];
  if (options?.escrowEnabled) {
    methods.push(...NIP46_ESCROW_PERMITTED_METHODS);
  }
  // Guard against silent duplication if the lists ever overlap.
  return Array.from(new Set(methods)).join(",");
}
