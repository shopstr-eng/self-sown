import {
  getEncodedToken,
  hasP2PKSignedProof,
  type Proof,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  buildEscrowLockOutputConfig,
  defaultEscrowExpiresAt,
  isEscrowAvailableForSeller,
  listBuyerEscrows,
  pruneResolvedBuyerEscrows,
  recordBuyerEscrow,
  signEscrowLockedProofs,
  BuyerEscrowRecord,
  ESCROW_DEFAULT_LOCK_SECONDS,
  ESCROW_MAX_LOCK_SECONDS,
} from "@/utils/cashu/escrow-checkout";

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
const workingStorage = (globalThis as any).localStorage;

const FLAG = "NEXT_PUBLIC_CASHU_ESCROW_ENABLED";

function makeRecord(overrides: Partial<BuyerEscrowRecord> = {}): BuyerEscrowRecord {
  const buyerPk = "a".repeat(64);
  return {
    escrowId: `${buyerPk}:order-1`,
    orderId: "order-1",
    sellerPubkey: "d".repeat(64),
    amountSats: 21_000,
    mintUrl: "https://mint.example",
    expiresAt: 1_900_000_000,
    createdAt: 1_800_000_000,
    lockedToken: "cashuAlocked",
    ...overrides,
  };
}

describe("escrow-checkout helpers", () => {
  beforeEach(() => {
    store.clear();
    delete process.env[FLAG];
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  describe("isEscrowAvailableForSeller", () => {
    it("requires BOTH the deployment flag and the seller opt-in", () => {
      // Flag off: never available, even for an opted-in seller.
      expect(isEscrowAvailableForSeller({ acceptsEscrow: true })).toBe(false);
      process.env[FLAG] = "true";
      expect(isEscrowAvailableForSeller({ acceptsEscrow: true })).toBe(true);
      // Flag on but seller hasn't opted in (default): not available.
      expect(isEscrowAvailableForSeller({ acceptsEscrow: false })).toBe(false);
      expect(isEscrowAvailableForSeller({})).toBe(false);
      expect(isEscrowAvailableForSeller(undefined)).toBe(false);
      expect(isEscrowAvailableForSeller(null)).toBe(false);
      // Anything other than the exact string "true" is off.
      process.env[FLAG] = "1";
      expect(isEscrowAvailableForSeller({ acceptsEscrow: true })).toBe(false);
    });
  });

  describe("buildEscrowLockOutputConfig", () => {
    it("locks to the seller with a buyer refund path after the locktime", () => {
      const config = buildEscrowLockOutputConfig({
        sellerPubkey: "d".repeat(64),
        buyerPubkey: "a".repeat(64),
        expiresAt: 1_900_000_000,
      });
      expect(config).toEqual({
        send: {
          type: "p2pk",
          options: {
            pubkey: "d".repeat(64),
            locktime: 1_900_000_000,
            refundKeys: ["a".repeat(64)],
            sigFlag: "SIG_INPUTS",
          },
        },
      });
    });
  });

  describe("defaultEscrowExpiresAt", () => {
    it("adds the default lock period and stays under the protocol max", () => {
      expect(defaultEscrowExpiresAt(1000)).toBe(
        1000 + ESCROW_DEFAULT_LOCK_SECONDS
      );
      expect(ESCROW_DEFAULT_LOCK_SECONDS).toBeLessThan(ESCROW_MAX_LOCK_SECONDS);
    });
  });

  describe("buyer escrow records", () => {
    it("round-trips records newest first", () => {
      const older = makeRecord({ orderId: "order-old", escrowId: "a".repeat(64) + ":order-old", createdAt: 1 });
      const newer = makeRecord();
      recordBuyerEscrow(older);
      recordBuyerEscrow(newer);
      const records = listBuyerEscrows();
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual(newer);
      expect(records[1]).toEqual(older);
    });

    it("dedups by escrow id (re-register after a retry is a no-op)", () => {
      const record = makeRecord();
      recordBuyerEscrow(record);
      recordBuyerEscrow({ ...record, createdAt: record.createdAt + 5 });
      const records = listBuyerEscrows();
      expect(records).toHaveLength(1);
      expect(records[0]!.createdAt).toBe(record.createdAt + 5);
    });

    it("never truncates records (each holds the only custody material)", () => {
      // Truncation would silently destroy the locked token of a possibly
      // unresolved escrow — funds would be stranded. Records only leave via
      // pruneResolvedBuyerEscrows after the escrow is terminal.
      for (let i = 0; i < 60; i++) {
        recordBuyerEscrow(
          makeRecord({
            escrowId: `${"a".repeat(64)}:order-${i}`,
            orderId: `order-${i}`,
          })
        );
      }
      expect(listBuyerEscrows()).toHaveLength(60);
    });

    it("fails closed (returns false) when the storage write fails", () => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
          removeItem: () => undefined,
          clear: () => undefined,
        },
      });
      try {
        expect(recordBuyerEscrow(makeRecord())).toBe(false);
      } finally {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: workingStorage,
        });
      }
    });

    it("prunes only the named terminal records", () => {
      const keep = makeRecord({
        escrowId: `${"a".repeat(64)}:keep`,
        orderId: "keep",
      });
      const resolved = makeRecord({
        escrowId: `${"a".repeat(64)}:resolved`,
        orderId: "resolved",
      });
      recordBuyerEscrow(keep);
      recordBuyerEscrow(resolved);
      pruneResolvedBuyerEscrows([resolved.escrowId]);
      const remaining = listBuyerEscrows();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.escrowId).toBe(keep.escrowId);
    });

    it("treats malformed storage as empty", () => {
      store.set("cashu_escrows", "{not json");
      expect(listBuyerEscrows()).toEqual([]);
      store.set("cashu_escrows", JSON.stringify([{ bogus: true }]));
      expect(listBuyerEscrows()).toEqual([]);
    });

    it("drops legacy records that hold no locked token", () => {
      const legacy = makeRecord();
      delete (legacy as any).lockedToken;
      store.set("cashu_escrows", JSON.stringify([legacy]));
      expect(listBuyerEscrows()).toEqual([]);
    });
  });

  describe("signEscrowLockedProofs", () => {
    const buyerSecret = generateSecretKey();
    const buyerPk = getPublicKey(buyerSecret);

    function lockedProof(): Proof {
      return {
        id: "009a1f293253e41e",
        amount: 100,
        secret: JSON.stringify([
          "P2PK",
          {
            nonce: "ab".repeat(16),
            data: "d".repeat(64),
            tags: [
              // Expired locktime: cashu-ts only accepts a refund-key
              // signature once the lock has expired (before that, the
              // seller's primary key is the only valid signer).
              ["locktime", "1700000000"],
              ["refund", buyerPk],
              ["sigflag", "SIG_INPUTS"],
            ],
          },
        ]),
        C: "02" + "cd".repeat(32),
      } as unknown as Proof; // wire-format proof: plain-integer amount
    }

    it("attaches a valid buyer P2PK witness to every locked proof", async () => {
      const token = getEncodedToken({
        mint: "https://mint.example",
        proofs: [lockedProof()],
      });
      const signed = await signEscrowLockedProofs(token, {
        _getPrivKey: async () => buyerSecret,
      });
      expect(signed).toHaveLength(1);
      // Verified with the real cashu-ts verifier — the same check the payout
      // worker runs before paying a refund.
      expect(hasP2PKSignedProof(buyerPk, signed[0]!)).toBe(true);
    });

    it("fails loudly for signers that cannot produce raw signatures", async () => {
      const token = getEncodedToken({
        mint: "https://mint.example",
        proofs: [lockedProof()],
      });
      await expect(signEscrowLockedProofs(token, {})).rejects.toThrow(
        /private key/
      );
    });
  });
});
