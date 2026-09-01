import {
  NIP46_BASE_PERMITTED_METHODS,
  NIP46_ESCROW_PERMITTED_METHODS,
  buildNip46PermittedMethods,
} from "@/utils/nostr/signers/nip46-permissions";
import { ESCROW_COMMITMENT_KIND } from "@/utils/cashu/escrow-commitment";

// The exact list bunkers were granted before permissions were made explicit.
// Any change here is a deliberate, reviewable permission change.
const LEGACY_CONNECT_STRING =
  "sign_event:0,sign_event:5,sign_event:13,sign_event:1059,sign_event:1111,sign_event:4550,sign_event:7375,sign_event:7376,sign_event:10002,sign_event:17375,kind:30019,sign_event:30402,sign_event:30405,sign_event:30406,sign_event:31555,sign_event:31989,sign_event:31990,sign_event:34550,get_public_key,nip44_encrypt,nip44_decrypt";

describe("nip46-permissions", () => {
  it("preserves the legacy baseline exactly when escrow is disabled", () => {
    expect(buildNip46PermittedMethods()).toBe(LEGACY_CONNECT_STRING);
    expect(buildNip46PermittedMethods({ escrowEnabled: false })).toBe(
      LEGACY_CONNECT_STRING
    );
  });

  it("appends the escrow commitment kind only when escrow is enabled", () => {
    const withEscrow = buildNip46PermittedMethods({ escrowEnabled: true });
    expect(withEscrow).toBe(
      `${LEGACY_CONNECT_STRING},sign_event:${ESCROW_COMMITMENT_KIND}`
    );
  });

  it("keeps the baseline free of escrow permissions", () => {
    for (const method of NIP46_BASE_PERMITTED_METHODS) {
      expect(NIP46_ESCROW_PERMITTED_METHODS).not.toContain(method);
    }
    expect(LEGACY_CONNECT_STRING).not.toContain(
      String(ESCROW_COMMITMENT_KIND)
    );
  });

  it("contains no duplicates", () => {
    const methods = buildNip46PermittedMethods({ escrowEnabled: true }).split(
      ","
    );
    expect(new Set(methods).size).toBe(methods.length);
  });
});
