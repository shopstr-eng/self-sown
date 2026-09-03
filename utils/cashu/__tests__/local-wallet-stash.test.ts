import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { stashProofsLocally } from "@/utils/cashu/local-wallet-stash";
import { recordBuyerEscrow } from "@/utils/cashu/escrow-checkout";

const mkProof = (secret: string, amount = 10): Proof =>
  ({
    id: "00d0a1b24d1c1a53",
    amount,
    secret,
    C: "02" + "cd".repeat(32),
  }) as unknown as Proof;

describe("stashProofsLocally", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("merges proofs into the spendable wallet with a history entry", () => {
    const stashed = stashProofsLocally(
      [mkProof("s1", 4), mkProof("s2", 6)],
      "https://mint.example"
    );
    expect(stashed).toBe(10);
    const tokens = JSON.parse(window.localStorage.getItem("tokens") ?? "[]");
    expect(tokens.map((p: Proof) => p.secret)).toEqual(["s1", "s2"]);
  });

  it("NEVER restashes proofs locked in a recorded buyer escrow", () => {
    // Regression: the checkout recoverable-proof tracker still holds the
    // P2PK-locked escrow outputs until the seller message publishes, so a
    // mid-flow failure routed them through this stash into the spendable
    // wallet — after a refresh the locked funds rendered as spendable AND
    // double-counted against the escrow record.
    const locked = mkProof("escrow-locked-secret", 100);
    const lockedToken = getEncodedToken({
      mint: "https://mint.example",
      proofs: [locked],
    });
    const recorded = recordBuyerEscrow({
      escrowId: `${"a".repeat(64)}:order-1`,
      orderId: "order-1",
      sellerPubkey: "d".repeat(64),
      amountSats: 100,
      mintUrl: "https://mint.example",
      expiresAt: 1_900_000_000,
      createdAt: 1_800_000_000,
      lockedToken,
      lockedSecrets: ["escrow-locked-secret"],
    });
    expect(recorded).toBe(true);

    const stashed = stashProofsLocally(
      [locked, mkProof("genuinely-spendable", 7)],
      "https://mint.example"
    );

    expect(stashed).toBe(7);
    const tokens = JSON.parse(window.localStorage.getItem("tokens") ?? "[]");
    expect(tokens.map((p: Proof) => p.secret)).toEqual(["genuinely-spendable"]);
  });

  it("strips locked proofs even for legacy escrow records without lockedSecrets", () => {
    const locked = mkProof("legacy-locked-secret", 100);
    const lockedToken = getEncodedToken({
      mint: "https://mint.example",
      proofs: [locked],
    });
    recordBuyerEscrow({
      escrowId: `${"a".repeat(64)}:order-legacy`,
      orderId: "order-legacy",
      sellerPubkey: "d".repeat(64),
      amountSats: 100,
      mintUrl: "https://mint.example",
      expiresAt: 1_900_000_000,
      createdAt: 1_800_000_000,
      lockedToken,
    });

    const stashed = stashProofsLocally([locked], "https://mint.example");
    expect(stashed).toBe(0);
    expect(window.localStorage.getItem("tokens")).toBeNull();
  });

  it("writes nothing when every proof is escrow-locked", () => {
    const locked = mkProof("only-locked", 42);
    recordBuyerEscrow({
      escrowId: `${"a".repeat(64)}:order-2`,
      orderId: "order-2",
      sellerPubkey: "d".repeat(64),
      amountSats: 42,
      mintUrl: "https://mint.example",
      expiresAt: 1_900_000_000,
      createdAt: 1_800_000_000,
      lockedToken: "cashuAwhatever",
      lockedSecrets: ["only-locked"],
    });
    expect(stashProofsLocally([locked], "https://mint.example")).toBe(0);
    expect(window.localStorage.getItem("tokens")).toBeNull();
    expect(window.localStorage.getItem("history")).toBeNull();
  });
});
