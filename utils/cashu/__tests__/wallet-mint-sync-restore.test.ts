import type { Proof } from "@cashu/cashu-ts";
import { restoreTokensFromProofEvents } from "@/utils/cashu/wallet-mint-sync";

// Minimal in-memory localStorage stub (node test environment).
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});
const MINT = "https://mint.example";

function lockedProof(nonce: string): Proof {
  return {
    id: "009a1f293253e41e",
    amount: 100,
    secret: JSON.stringify([
      "P2PK",
      {
        nonce,
        data: "d".repeat(64),
        tags: [["locktime", "1900000000"]],
      },
    ]),
    C: "02" + "cd".repeat(32),
  } as unknown as Proof;
}

describe("restoreTokensFromProofEvents — escrow backups", () => {
  beforeEach(() => store.clear());

  it("never restores escrow-locked proofs into the spendable wallet", async () => {
    // Escrow-marked kind-7375 events hold P2PK-locked proofs the buyer
    // cannot spend before expiry (and the seller can) — they restore into
    // `cashu_escrows` via restoreEscrowsFromProofEvents, never `tokens`.
    // With ONLY escrow events present the restore must no-op entirely:
    // if one leaked through, its mint probe would fail (no such mint) and
    // surface as a skipped proof.
    const result = await restoreTokensFromProofEvents([
      {
        mint: MINT,
        proofs: [lockedProof("ab".repeat(16)), lockedProof("cd".repeat(16))],
        created_at: 1_800_000_000,
        escrow: {
          escrowId: `${"a".repeat(64)}:order-1`,
          orderId: "order-1",
          sellerPubkey: "d".repeat(64),
          amountSats: 200,
          expiresAt: 1_900_000_000,
          createdAt: 1_800_000_000,
        },
      },
    ]);
    expect(result.restoredCount).toBe(0);
    expect(result.restoredSats).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(JSON.parse(store.get("tokens") ?? "[]")).toEqual([]);
    expect(store.has("cashu_escrows")).toBe(false);
  });
});
