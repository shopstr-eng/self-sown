import {
  getEncodedToken,
  hasP2PKSignedProof,
  type Proof,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  buildEscrowLockOutputConfig,
  decodeEscrowLockedProofs,
  defaultEscrowExpiresAt,
  isEscrowAvailableForSeller,
  isMintAlreadySpentError,
  isSellerEscrowRedeemed,
  listBuyerEscrows,
  listRedeemedSellerEscrows,
  markSellerEscrowRedeemed,
  listEscrowLockedSecrets,
  pruneResolvedBuyerEscrows,
  recordBuyerEscrow,
  stripEscrowLockedProofs,
  stripEscrowLockedProofsAsync,
  resolveEscrowLockSeconds,
  formatEscrowLockDuration,
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

  describe("resolveEscrowLockSeconds", () => {
    it("defaults to the standard lock period and stays under the max", () => {
      expect(resolveEscrowLockSeconds(undefined)).toBe(
        ESCROW_DEFAULT_LOCK_SECONDS
      );
      expect(ESCROW_DEFAULT_LOCK_SECONDS).toBeLessThan(ESCROW_MAX_LOCK_SECONDS);
    });

    it("honors a positive staging override and clamps to the max", () => {
      expect(resolveEscrowLockSeconds("420")).toBe(420);
      expect(resolveEscrowLockSeconds(String(ESCROW_MAX_LOCK_SECONDS * 4))).toBe(
        ESCROW_MAX_LOCK_SECONDS
      );
    });

    it("ignores blank, non-numeric, and non-positive overrides", () => {
      for (const bad of ["", "abc", "0", "-60"]) {
        expect(resolveEscrowLockSeconds(bad)).toBe(ESCROW_DEFAULT_LOCK_SECONDS);
      }
    });
  });

  describe("formatEscrowLockDuration", () => {
    it("labels days, hours, minutes, and odd seconds", () => {
      expect(formatEscrowLockDuration(14 * 86400)).toBe("14 days");
      expect(formatEscrowLockDuration(2 * 3600)).toBe("2 hours");
      expect(formatEscrowLockDuration(420)).toBe("7 minutes");
      expect(formatEscrowLockDuration(90)).toBe("90 seconds");
    });
  });

  describe("defaultEscrowExpiresAt", () => {
    it("adds the resolved lock period", () => {
      // NEXT_PUBLIC_* vars are inlined at build time, so assert against the
      // same ambient value the transform baked in (unset => default).
      expect(defaultEscrowExpiresAt(1000)).toBe(
        1000 +
          resolveEscrowLockSeconds(
            process.env.NEXT_PUBLIC_CASHU_ESCROW_LOCK_SECONDS
          )
      );
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

  describe("stripEscrowLockedProofs / listEscrowLockedSecrets", () => {
    const lockedProofA = {
      id: "009a1f293253e41e",
      amount: 100,
      secret: "locked-secret-a",
      C: "02" + "cd".repeat(32),
    } as unknown as Proof;
    const lockedProofB = {
      id: "009a1f293253e41e",
      amount: 200,
      secret: "locked-secret-b",
      C: "02" + "cd".repeat(32),
    } as unknown as Proof;
    const spendableProof = {
      id: "009a1f293253e41e",
      amount: 50,
      secret: "spendable-secret",
      C: "02" + "cd".repeat(32),
    } as unknown as Proof;

    it("strips proofs recorded as escrow-locked via lockedSecrets", () => {
      recordBuyerEscrow(
        makeRecord({ lockedSecrets: ["locked-secret-a", "locked-secret-b"] })
      );
      const result = stripEscrowLockedProofs([
        lockedProofA,
        spendableProof,
        lockedProofB,
      ]);
      expect(result).toEqual([spendableProof]);
    });

    it("falls back to decoding lockedToken when lockedSecrets is absent", () => {
      const lockedToken = getEncodedToken({
        mint: "https://mint.example",
        proofs: [lockedProofA],
      });
      recordBuyerEscrow(makeRecord({ lockedToken }));
      expect(listEscrowLockedSecrets().has("locked-secret-a")).toBe(true);
      const result = stripEscrowLockedProofs([lockedProofA, spendableProof]);
      expect(result).toEqual([spendableProof]);
    });

    it("collects secrets across multiple escrow records", () => {
      recordBuyerEscrow(
        makeRecord({
          escrowId: `${"a".repeat(64)}:order-1`,
          orderId: "order-1",
          lockedSecrets: ["locked-secret-a"],
        })
      );
      recordBuyerEscrow(
        makeRecord({
          escrowId: `${"a".repeat(64)}:order-2`,
          orderId: "order-2",
          lockedSecrets: ["locked-secret-b"],
        })
      );
      expect(stripEscrowLockedProofs([lockedProofA, lockedProofB])).toEqual(
        []
      );
    });

    it("is a no-op pass-through when no escrows are recorded", () => {
      const input = [lockedProofA, spendableProof];
      expect(stripEscrowLockedProofs(input)).toBe(input);
      expect(stripEscrowLockedProofs([])).toEqual([]);
    });

    it("ignores malformed lockedSecrets entries and undecodable tokens", () => {
      recordBuyerEscrow(
        makeRecord({
          lockedToken: "cashuAnot-valid-token",
          lockedSecrets: ["locked-secret-a", 42 as unknown as string],
        })
      );
      // Still strips the valid secret; the garbage entries are skipped.
      expect(stripEscrowLockedProofs([lockedProofA, spendableProof])).toEqual([
        spendableProof,
      ]);
    });

    it("sync variant SKIPS a v2-keyset legacy record it cannot decode", () => {
      // Pins the known limitation the async variant exists to cover: a
      // legacy record (no lockedSecrets) holding a v2-keyset token needs a
      // mint keyset fetch to decode, which the sync path cannot do.
      const v2Token = getEncodedToken({
        mint: "https://mint.example",
        proofs: [
          {
            id: "01" + "ab".repeat(31),
            amount: 100,
            secret: "v2-locked-secret",
            C: "02" + "cd".repeat(32),
          } as unknown as Proof,
        ],
      });
      recordBuyerEscrow(makeRecord({ lockedToken: v2Token }));
      expect(listEscrowLockedSecrets().has("v2-locked-secret")).toBe(false);
    });
  });

  describe("stripEscrowLockedProofsAsync / listEscrowLockedSecretsAsync", () => {
    const V2_KEYSET_ID = "01" + "ab".repeat(31);
    const MINT = "https://mint-v2.example";

    const v2LockedProof = {
      id: V2_KEYSET_ID,
      amount: 100,
      secret: "v2-locked-secret",
      C: "02" + "cd".repeat(32),
    } as unknown as Proof;
    const spendableProof = {
      id: "009a1f293253e41e",
      amount: 50,
      secret: "spendable-secret",
      C: "02" + "cd".repeat(32),
    } as unknown as Proof;

    const realFetch = (globalThis as any).fetch;
    afterEach(() => {
      (globalThis as any).fetch = realFetch;
      jest.restoreAllMocks();
    });

    it("resolves a legacy v2-keyset record via the mint keyset fetch", async () => {
      // The reviewer-flagged gap: a legacy escrow record (no lockedSecrets)
      // holding a v2-keyset token MUST NOT be silently skipped — the async
      // variant fetches the mint's keyset ids so the locked proof is
      // recognized and stripped even at hydration time.
      const v2Token = getEncodedToken({
        mint: MINT,
        proofs: [v2LockedProof],
      });
      recordBuyerEscrow(makeRecord({ lockedToken: v2Token, mintUrl: MINT }));
      const fetchSpy = ((globalThis as any).fetch = jest
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ keysets: [{ id: V2_KEYSET_ID }] }),
        }));

      const result = await stripEscrowLockedProofsAsync([
        v2LockedProof,
        spendableProof,
      ]);
      expect(result).toEqual([spendableProof]);
      expect(fetchSpy).toHaveBeenCalledWith(`${MINT}/v1/keysets`);
      // The decoded secrets are MIGRATED back onto the record, so no future
      // pass (including the sync stash chokepoint) has to decode again.
      const stored = listBuyerEscrows().find((r) => r.mintUrl === MINT);
      expect(stored?.lockedSecrets).toEqual(["v2-locked-secret"]);
    });

    it("prefers lockedSecrets without any network call", async () => {
      recordBuyerEscrow(makeRecord({ lockedSecrets: ["v2-locked-secret"] }));
      const fetchSpy = ((globalThis as any).fetch = jest.fn());
      const result = await stripEscrowLockedProofsAsync([
        v2LockedProof,
        spendableProof,
      ]);
      expect(result).toEqual([spendableProof]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("FAILS CLOSED when a legacy record's mint is unreachable: P2PK-shaped proofs are stripped", async () => {
      // Unreachable mint for the legacy v2 record: it can't be decoded this
      // pass (failure is never cached, so the next hydration retries). The
      // invariant "locked funds can never render spendable" must still hold,
      // so the async strip fails closed on the P2PK well-known-secret shape —
      // every escrow-locked proof carries it and no legitimately-stored
      // wallet proof ever does. Distinct mint URL: the keyset-id cache is
      // per-mint and a prior test warmed the entry for MINT.
      const DOWN_MINT = "https://mint-down.example";
      const p2pkLockedProof = {
        id: V2_KEYSET_ID,
        amount: 100,
        secret: JSON.stringify([
          "P2PK",
          { nonce: "ab".repeat(16), data: "02" + "cd".repeat(32), tags: [] },
        ]),
        C: "02" + "cd".repeat(32),
      } as unknown as Proof;
      const v2Token = getEncodedToken({
        mint: DOWN_MINT,
        proofs: [p2pkLockedProof],
      });
      recordBuyerEscrow(makeRecord({ lockedToken: v2Token, mintUrl: DOWN_MINT }));
      recordBuyerEscrow(
        makeRecord({
          escrowId: `${"a".repeat(64)}:order-2`,
          orderId: "order-2",
          lockedSecrets: ["locked-secret-b"],
        })
      );
      (globalThis as any).fetch = jest.fn().mockRejectedValue(
        new Error("mint down")
      );
      const lockedB = {
        id: "009a1f293253e41e",
        amount: 200,
        secret: "locked-secret-b",
        C: "02" + "cd".repeat(32),
      } as unknown as Proof;
      const result = await stripEscrowLockedProofsAsync([
        p2pkLockedProof,
        lockedB,
        spendableProof,
      ]);
      // P2PK-shaped leaked proof stripped via the fail-closed shape check
      // even though its record couldn't be decoded; lockedB stripped via
      // lockedSecrets; the plain spendable proof survives.
      expect(result).toEqual([spendableProof]);
    });

    it("does NOT over-strip when a legacy record is unresolved: non-P2PK unknown secrets pass through", async () => {
      // Fail-closed must be surgical: an unresolved legacy record strips
      // P2PK-shaped secrets only — ordinary wallet proofs (random hex
      // secrets) are never escrow material and must stay spendable.
      const DOWN_MINT2 = "https://mint-down-2.example";
      const v2Token = getEncodedToken({
        mint: DOWN_MINT2,
        proofs: [v2LockedProof],
      });
      recordBuyerEscrow(makeRecord({ lockedToken: v2Token, mintUrl: DOWN_MINT2 }));
      (globalThis as any).fetch = jest.fn().mockRejectedValue(
        new Error("mint down")
      );
      const result = await stripEscrowLockedProofsAsync([spendableProof]);
      expect(result).toEqual([spendableProof]);
    });
  });

  describe("seller payout redemption markers", () => {
    it("round-trips markers newest first", () => {
      markSellerEscrowRedeemed("escrow-old");
      markSellerEscrowRedeemed("escrow-new");
      expect(listRedeemedSellerEscrows()).toEqual(["escrow-new", "escrow-old"]);
      expect(isSellerEscrowRedeemed("escrow-old")).toBe(true);
      expect(isSellerEscrowRedeemed("escrow-new")).toBe(true);
    });

    it("dedups by escrow id (marking twice is a no-op)", () => {
      markSellerEscrowRedeemed("escrow-1");
      markSellerEscrowRedeemed("escrow-1");
      expect(listRedeemedSellerEscrows()).toEqual(["escrow-1"]);
    });

    it("does not mark other escrows", () => {
      markSellerEscrowRedeemed("escrow-1");
      expect(isSellerEscrowRedeemed("escrow-2")).toBe(false);
    });

    it("treats malformed storage as empty", () => {
      store.set("cashu_escrow_seller_redeemed", "{not json");
      expect(listRedeemedSellerEscrows()).toEqual([]);
      store.set(
        "cashu_escrow_seller_redeemed",
        JSON.stringify(["escrow-1", 42, null])
      );
      expect(listRedeemedSellerEscrows()).toEqual(["escrow-1"]);
    });

    it("never throws when the storage write fails", () => {
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
        expect(() => markSellerEscrowRedeemed("escrow-1")).not.toThrow();
        expect(isSellerEscrowRedeemed("escrow-1")).toBe(false);
      } finally {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: workingStorage,
        });
      }
    });
  });

  describe("isMintAlreadySpentError", () => {
    it("detects the NUT-00 11001 code (cashu-ts MintOperationError)", () => {
      const error = new Error("Token already spent.");
      (error as { code?: number }).code = 11001;
      expect(isMintAlreadySpentError(error)).toBe(true);
    });

    it("detects unstructured already-spent messages case-insensitively", () => {
      expect(
        isMintAlreadySpentError(new Error("tokens ALREADY SPENT at mint"))
      ).toBe(true);
    });

    it("rejects genuine failures and non-Error values", () => {
      expect(isMintAlreadySpentError(new Error("mint exploded"))).toBe(false);
      expect(isMintAlreadySpentError(new Error("network unreachable"))).toBe(
        false
      );
      expect(isMintAlreadySpentError("already spent")).toBe(false);
      expect(isMintAlreadySpentError(undefined)).toBe(false);
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

  describe("decodeEscrowLockedProofs with v2 keyset IDs", () => {
    // Newer Nutshell mints (e.g. 0.20+) issue "v2" keyset IDs (0x01-prefixed,
    // 64 hex chars). Real-library contract: cashu-ts getDecodedToken needs the
    // mint's keyset ids to decode such proofs, so the escrow decode falls back
    // to fetching them. A mocked-library test would never catch this drift.
    const V2_KEYSET_ID = "01" + "ab".repeat(31);
    const MINT = "https://mint.example";

    function v2LockedToken(): string {
      return getEncodedToken({
        mint: MINT,
        proofs: [
          {
            id: V2_KEYSET_ID,
            amount: 100,
            secret: "s".repeat(64),
            C: "02" + "cd".repeat(32),
          } as unknown as Proof,
        ],
      });
    }

    const realFetch = (globalThis as any).fetch;
    afterEach(() => {
      (globalThis as any).fetch = realFetch;
      jest.restoreAllMocks();
    });

    it("decodes via the mint's keyset list when the plain decode throws", async () => {
      const fetchSpy = ((globalThis as any).fetch = jest
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ keysets: [{ id: V2_KEYSET_ID }] }),
        }));
      const { mint, proofs } = await decodeEscrowLockedProofs(
        v2LockedToken(),
        MINT
      );
      expect(mint).toBe(MINT);
      expect(proofs).toHaveLength(1);
      expect(proofs[0]!.amount).toBe(100);
      expect(fetchSpy).toHaveBeenCalledWith(`${MINT}/v1/keysets`);
    });

    it("does not fetch keysets for legacy v0/v1 keyset IDs", async () => {
      const fetchSpy = ((globalThis as any).fetch = jest.fn());
      const { proofs } = await decodeEscrowLockedProofs(
        getEncodedToken({
          mint: MINT,
          proofs: [
            {
              id: "009a1f293253e41e",
              amount: 100,
              secret: "s".repeat(64),
              C: "02" + "cd".repeat(32),
            } as unknown as Proof,
          ],
        }),
        MINT
      );
      expect(proofs).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("propagates the decoded token's unit (the redeem path re-receives it)", async () => {
      // Regression: cashu-ts receive() rejects a token object whose unit is
      // absent, so dropping unit here broke payout redemption against real
      // mints with "Token is not in wallet unit".
      const { unit } = await decodeEscrowLockedProofs(
        getEncodedToken({
          mint: MINT,
          unit: "sat",
          proofs: [
            {
              id: "009a1f293253e41e",
              amount: 100,
              secret: "s".repeat(64),
              C: "02" + "cd".repeat(32),
            } as unknown as Proof,
          ],
        })
      );
      expect(unit).toBe("sat");
    });

    it("rethrows the decode error when no mint URL is known", async () => {
      await expect(
        decodeEscrowLockedProofs(v2LockedToken())
      ).rejects.toThrow(/short keyset id/i);
    });
  });
});
