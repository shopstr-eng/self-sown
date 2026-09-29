/**
 * Audience binding in the signed key-management proofs.
 *
 * The proof verifier is a subset matcher (expected tags must all appear in
 * the signed event), so the EXPECTED proof must bind exactly the fields the
 * server acts on. For audience-aware requests that means the audience — not
 * the derived permissions tier — or a signed legacy proof could be replayed
 * with a substituted audience to mint a key the owner never authorized.
 */

import {
  buildApiKeyCreateProof,
  buildMcpRequestProofTemplate,
  buildOnboardExistingPubkeyProof,
  matchesMcpRequestProof,
} from "@/utils/mcp/request-proof";

const PUBKEY = "d".repeat(64);

describe("buildApiKeyCreateProof audience binding", () => {
  it("binds audience (not permissions) for audience-aware requests", () => {
    const proof = buildApiKeyCreateProof({
      name: "Agent",
      audience: "shopping",
      pubkey: PUBKEY,
    });
    expect(proof.fields).toEqual({ name: "Agent", audience: "shopping" });
    expect(proof.fields).not.toHaveProperty("permissions");
  });

  it("keeps binding the permissions tier for legacy requests", () => {
    const proof = buildApiKeyCreateProof({
      name: "Agent",
      permissions: "read_write",
      pubkey: PUBKEY,
    });
    expect(proof.fields).toEqual({
      name: "Agent",
      permissions: "read_write",
    });
    expect(proof.fields).not.toHaveProperty("audience");
  });
});

describe("buildOnboardExistingPubkeyProof audience binding", () => {
  it("binds audience (not permissions) for audience-aware requests", () => {
    const proof = buildOnboardExistingPubkeyProof({
      name: "Agent",
      audience: "shopping",
      contact: "agent@example.com",
      pubkey: PUBKEY,
    });
    expect(proof.fields).toEqual({
      name: "Agent",
      audience: "shopping",
      contact: "agent@example.com",
    });
    expect(proof.fields).not.toHaveProperty("permissions");
    expect(proof.action).toBe("onboard_existing_pubkey");
    expect(proof.path).toBe("/api/mcp/onboard");
  });

  it("keeps binding the permissions tier for legacy requests", () => {
    const proof = buildOnboardExistingPubkeyProof({
      name: "Agent",
      permissions: "read",
      pubkey: PUBKEY,
    });
    expect(proof.fields).toEqual({
      name: "Agent",
      permissions: "read",
      contact: undefined,
    });
    expect(proof.fields).not.toHaveProperty("audience");
  });

  it("rejects both replay directions through the real subset matcher", () => {
    const legacyProof = buildOnboardExistingPubkeyProof({
      name: "Agent",
      permissions: "read",
      pubkey: PUBKEY,
    });
    const modernProof = buildOnboardExistingPubkeyProof({
      name: "Agent",
      audience: "shopping",
      pubkey: PUBKEY,
    });
    // Stand-ins for the signed events: same kind/content/tags shape the
    // matcher inspects.
    const legacySigned = buildMcpRequestProofTemplate(legacyProof) as any;
    const modernSigned = buildMcpRequestProofTemplate(modernProof) as any;

    // The architect-flagged attack: replaying a legacy owner signature with
    // audience:"shopping" substituted into the request must NOT verify.
    expect(matchesMcpRequestProof(legacySigned, modernProof)).toBe(false);
    // The mirror: stripping audience from an audience-signed request must
    // NOT match the legacy expected shape either.
    expect(matchesMcpRequestProof(modernSigned, legacyProof)).toBe(false);
    // Sanity: matching shapes still verify.
    expect(matchesMcpRequestProof(legacySigned, legacyProof)).toBe(true);
    expect(matchesMcpRequestProof(modernSigned, modernProof)).toBe(true);
  });
});
