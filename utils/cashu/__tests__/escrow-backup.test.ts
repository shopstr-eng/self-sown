import { getDecodedToken, type Proof } from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  describeEscrowBackupWarning,
  describeEscrowRestore,
  publishEscrowBackup,
  republishMissingEscrowBackups,
  restoreEscrowsFromProofEvents,
  type EscrowBackupInfo,
} from "@/utils/cashu/escrow-backup";
import {
  listBuyerEscrows,
  recordBuyerEscrow,
  type BuyerEscrowRecord,
} from "@/utils/cashu/escrow-checkout";
import { filterUnspentProofs } from "@/utils/cashu/wallet-mint-sync";
import { finalizeAndSendNostrEvent } from "@/utils/nostr/nostr-helper-functions";

jest.mock("@/utils/cashu/wallet-mint-sync", () => ({
  filterUnspentProofs: jest.fn(),
}));
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  finalizeAndSendNostrEvent: jest.fn(),
}));

const mockFilterUnspentProofs = filterUnspentProofs as jest.Mock;
const mockFinalize = finalizeAndSendNostrEvent as jest.Mock;

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
const BUYER_SK = generateSecretKey();
const BUYER_PK = getPublicKey(BUYER_SK);
const SELLER_PK = "d".repeat(64);
const MINT = "https://mint.example";
const EXPIRES_AT = 1_900_000_000;

function lockedProof(amount: number, nonce: string): Proof {
  return {
    id: "009a1f293253e41e",
    amount,
    secret: JSON.stringify([
      "P2PK",
      {
        nonce,
        data: SELLER_PK,
        tags: [
          ["locktime", String(EXPIRES_AT)],
          ["refund", BUYER_PK],
          ["sigflag", "SIG_INPUTS"],
        ],
      },
    ]),
    C: "02" + "cd".repeat(32),
  } as unknown as Proof;
}

const PROOFS: Proof[] = [
  lockedProof(100, "ab".repeat(16)),
  lockedProof(21, "cd".repeat(16)),
];

function makeRecord(
  overrides: Partial<BuyerEscrowRecord> = {}
): BuyerEscrowRecord {
  const { getEncodedToken } = jest.requireActual("@cashu/cashu-ts") as any;
  return {
    escrowId: `${BUYER_PK}:order-1`,
    orderId: "order-1",
    sellerPubkey: SELLER_PK,
    amountSats: 121,
    mintUrl: MINT,
    expiresAt: EXPIRES_AT,
    createdAt: 1_800_000_000,
    lockedToken: getEncodedToken({ mint: MINT, proofs: PROOFS }),
    ...overrides,
  };
}

function backupEvent(
  info: EscrowBackupInfo,
  proofs: Proof[] = PROOFS,
  mint: string = MINT
) {
  return { mint, proofs, escrow: info, created_at: 1_800_000_500 };
}

function infoFor(record: BuyerEscrowRecord): EscrowBackupInfo {
  return {
    escrowId: record.escrowId,
    orderId: record.orderId,
    sellerPubkey: record.sellerPubkey,
    amountSats: record.amountSats,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

describe("escrow-backup", () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    mockFilterUnspentProofs.mockImplementation(
      async (_mint: string, proofs: Proof[]) => ({
        unspent: proofs,
        spentCount: 0,
        checked: true,
      })
    );
  });

  describe("publishEscrowBackup", () => {
    const signer = {
      getPubKey: async () => BUYER_PK,
      encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
    };

    it("publishes the locked proofs as an escrow-marked kind-7375 event", async () => {
      mockFinalize.mockResolvedValue({ id: "event-id" });
      const record = makeRecord();
      const result = await publishEscrowBackup(
        {} as any,
        signer as any,
        record
      );
      expect(result).toEqual({ published: true });
      expect(mockFinalize).toHaveBeenCalledTimes(1);
      const template = mockFinalize.mock.calls[0][2];
      expect(template.kind).toBe(7375);
      const content = JSON.parse(template.content.slice("enc:".length));
      expect(content.mint).toBe(MINT);
      expect(content.proofs).toHaveLength(2);
      expect(content.escrow).toEqual(infoFor(record));
    });

    it("never throws — reports publish_failed when publishing fails", async () => {
      mockFinalize.mockRejectedValue(new Error("relays down"));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      await expect(
        publishEscrowBackup({} as any, signer as any, makeRecord())
      ).resolves.toEqual({ published: false, failure: "publish_failed" });
      warn.mockRestore();
    });

    it("reports publish_failed when the signed event comes back empty", async () => {
      mockFinalize.mockResolvedValue(undefined);
      await expect(
        publishEscrowBackup({} as any, signer as any, makeRecord())
      ).resolves.toEqual({ published: false, failure: "publish_failed" });
    });

    it("reports encryption_failed when the signer cannot encrypt (remote signer without NIP-44)", async () => {
      // A NIP-46 bunker that lacks NIP-44 support (or where the user denied
      // the permission) rejects the nip44_encrypt RPC. This failure is
      // permanent for that signer — the buyer must be told their escrow has
      // no recovery backup, not silently retried forever.
      const nip04OnlySigner = {
        getPubKey: async () => BUYER_PK,
        encrypt: async () => {
          throw new Error("unsupported method: nip44_encrypt");
        },
      };
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const result = await publishEscrowBackup(
        {} as any,
        nip04OnlySigner as any,
        makeRecord()
      );
      expect(result).toEqual({
        published: false,
        failure: "encryption_failed",
      });
      expect(mockFinalize).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("reports unavailable when there is no signer", async () => {
      await expect(
        publishEscrowBackup({} as any, undefined, makeRecord())
      ).resolves.toEqual({ published: false, failure: "unavailable" });
      await expect(
        publishEscrowBackup(undefined, signer as any, makeRecord())
      ).resolves.toEqual({ published: false, failure: "unavailable" });
      expect(mockFinalize).not.toHaveBeenCalled();
    });
  });

  describe("republishMissingEscrowBackups", () => {
    const signer = {
      getPubKey: async () => BUYER_PK,
      encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
    };

    it("publishes backups only for records missing from the proof events", async () => {
      mockFinalize.mockResolvedValue({ id: "event-id" });
      const backedUp = makeRecord();
      const missing = makeRecord({
        escrowId: `${BUYER_PK}:order-2`,
        orderId: "order-2",
      });
      recordBuyerEscrow(backedUp);
      recordBuyerEscrow(missing);
      const result = await republishMissingEscrowBackups(
        {} as any,
        signer as any,
        [backupEvent(infoFor(backedUp))]
      );
      expect(result.published).toBe(1);
      expect(result.unbacked).toEqual([]);
      expect(mockFinalize).toHaveBeenCalledTimes(1);
      const content = JSON.parse(
        (mockFinalize.mock.calls[0][2].content as string).slice("enc:".length)
      );
      expect(content.escrow.escrowId).toBe(missing.escrowId);
    });

    it("reports records that stay unbacked, with the failure reason, so the UI can warn", async () => {
      // Remote signer without NIP-44: the retry can never succeed — it must
      // be reported, not silently retried on every wallet visit.
      const nip04OnlySigner = {
        getPubKey: async () => BUYER_PK,
        encrypt: async () => {
          throw new Error("unsupported method: nip44_encrypt");
        },
      };
      const record = makeRecord();
      recordBuyerEscrow(record);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const result = await republishMissingEscrowBackups(
        {} as any,
        nip04OnlySigner as any,
        []
      );
      expect(result.published).toBe(0);
      expect(result.unbacked).toEqual([
        {
          escrowId: record.escrowId,
          orderId: record.orderId,
          failure: "encryption_failed",
        },
      ]);
      warn.mockRestore();
    });

    it("stops re-prompting a signer whose encryption permanently fails, but keeps the record unbacked", async () => {
      // encryption_failed is permanent for a nip04-only bunker: the second
      // republish run must not fire another futile encrypt RPC, but the
      // record must still report as unbacked so the warning banner stays up.
      const encrypt = jest.fn(async () => {
        throw new Error("unsupported method: nip44_encrypt");
      });
      const nip04OnlySigner = {
        getPubKey: async () => BUYER_PK,
        encrypt,
      };
      const record = makeRecord({
        escrowId: `${BUYER_PK}:order-3`,
        orderId: "order-3",
      });
      recordBuyerEscrow(record);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      const first = await republishMissingEscrowBackups(
        {} as any,
        nip04OnlySigner as any,
        []
      );
      const second = await republishMissingEscrowBackups(
        {} as any,
        nip04OnlySigner as any,
        []
      );

      expect(encrypt).toHaveBeenCalledTimes(1);
      const expectedUnbacked = [
        {
          escrowId: record.escrowId,
          orderId: record.orderId,
          failure: "encryption_failed",
        },
      ];
      expect(first.unbacked).toEqual(expectedUnbacked);
      expect(second.unbacked).toEqual(expectedUnbacked);
      expect(second.published).toBe(0);
      warn.mockRestore();
    });

    it("keeps retrying transient publish failures", async () => {
      // publish_failed is retryable (relay outage): every run must attempt
      // the publish again — the give-up set must only catch permanent
      // encryption failures.
      mockFinalize.mockResolvedValue(null);
      const record = makeRecord({
        escrowId: `${BUYER_PK}:order-4`,
        orderId: "order-4",
      });
      recordBuyerEscrow(record);

      const first = await republishMissingEscrowBackups(
        {} as any,
        signer as any,
        []
      );
      const second = await republishMissingEscrowBackups(
        {} as any,
        signer as any,
        []
      );

      expect(mockFinalize).toHaveBeenCalledTimes(2);
      expect(first.unbacked[0]?.failure).toBe("publish_failed");
      expect(second.unbacked[0]?.failure).toBe("publish_failed");
    });

    it("retries a transient encrypt failure instead of giving up", async () => {
      // A transport-level encrypt failure (bunker timeout/disconnect) is
      // retryable — only capability/permission rejections are permanent, so
      // this must classify publish_failed and re-attempt on the next run.
      const encrypt = jest.fn(async () => {
        throw new Error("request timed out waiting for bunker response");
      });
      const flakySigner = { getPubKey: async () => BUYER_PK, encrypt };
      const record = makeRecord({
        escrowId: `${BUYER_PK}:order-5`,
        orderId: "order-5",
      });
      recordBuyerEscrow(record);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      const first = await republishMissingEscrowBackups(
        {} as any,
        flakySigner as any,
        []
      );
      const second = await republishMissingEscrowBackups(
        {} as any,
        flakySigner as any,
        []
      );

      expect(encrypt).toHaveBeenCalledTimes(2);
      expect(first.unbacked[0]?.failure).toBe("publish_failed");
      expect(second.unbacked[0]?.failure).toBe("publish_failed");
      warn.mockRestore();
    });

    it("retries with a replacement signer that CAN encrypt", async () => {
      // Give-up is signer-scoped: swapping a nip04-only bunker for a local
      // (NIP-44-capable) signer mid-session must get a fresh attempt, not
      // stay suppressed by the old signer's cache entry.
      const nip04OnlySigner = {
        getPubKey: async () => BUYER_PK,
        encrypt: jest.fn(async () => {
          throw new Error("unsupported method: nip44_encrypt");
        }),
      };
      const capableSigner = {
        getPubKey: async () => BUYER_PK,
        encrypt: jest.fn(async (_pk: string, pt: string) => `enc:${pt}`),
      };
      const record = makeRecord({
        escrowId: `${BUYER_PK}:order-6`,
        orderId: "order-6",
      });
      recordBuyerEscrow(record);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockFinalize.mockResolvedValue({ id: "event-id" });

      const first = await republishMissingEscrowBackups(
        {} as any,
        nip04OnlySigner as any,
        []
      );
      const second = await republishMissingEscrowBackups(
        {} as any,
        capableSigner as any,
        []
      );

      expect(first.unbacked[0]?.failure).toBe("encryption_failed");
      expect(capableSigner.encrypt).toHaveBeenCalledTimes(1);
      expect(second.published).toBe(1);
      expect(second.unbacked).toEqual([]);
      warn.mockRestore();
    });
  });

  describe("restoreEscrowsFromProofEvents", () => {
    it("rebuilds the escrow record with a re-encoded locked token", async () => {
      const record = makeRecord();
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record)),
      ]);
      expect(result.restoredEscrowCount).toBe(1);
      expect(result.restoredEscrowSats).toBe(121);
      expect(result.unrecoveredEscrows).toEqual([]);

      const stored = listBuyerEscrows();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.escrowId).toBe(record.escrowId);
      // The restored token decodes back to the same locked proofs.
      const decoded = getDecodedToken(stored[0]!.lockedToken, []);
      expect(decoded.mint).toBe(MINT);
      expect(decoded.proofs.map((p: Proof) => p.secret).sort()).toEqual(
        PROOFS.map((p) => p.secret).sort()
      );
      // The restored record carries lockedSecrets, so spendable-wallet
      // reconciliation never has to decode the token (a restored v2-keyset
      // token can't be decoded synchronously).
      expect(stored[0]!.lockedSecrets?.sort()).toEqual(
        PROOFS.map((p) => p.secret).sort()
      );
    });

    it("verifies proofs against the mint before restoring", async () => {
      const record = makeRecord();
      await restoreEscrowsFromProofEvents([backupEvent(infoFor(record))]);
      expect(mockFilterUnspentProofs).toHaveBeenCalledWith(MINT, PROOFS);
    });

    it("accepts compressed (02-prefixed) P2PK lock pubkeys — the form mints emit", async () => {
      // Regression: real mints write the lock pubkey as compressed SEC
      // (02/03 + x-only) while the record carries the x-only Nostr pubkey.
      // Comparing them directly rejected every real backup as invalid.
      const compressedProofs = PROOFS.map((proof) => ({
        ...proof,
        secret: JSON.stringify([
          "P2PK",
          {
            nonce: "ef".repeat(16),
            data: "02" + SELLER_PK,
            tags: [
              ["locktime", String(EXPIRES_AT)],
              ["refund", BUYER_PK],
              ["sigflag", "SIG_INPUTS"],
            ],
          },
        ]),
      })) as unknown as Proof[];
      const record = makeRecord();
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record), compressedProofs),
      ]);
      expect(result.unrecoveredEscrows).toEqual([]);
      expect(result.restoredEscrowCount).toBe(1);
      expect(listBuyerEscrows()[0]!.escrowId).toBe(record.escrowId);
    });

    it("skips escrows the buyer still holds locally (custody intact)", async () => {
      const record = makeRecord();
      recordBuyerEscrow(record);
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record)),
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(result.unrecoveredEscrows).toEqual([]);
      expect(mockFilterUnspentProofs).not.toHaveBeenCalled();
      expect(listBuyerEscrows()).toHaveLength(1);
    });

    it("fails closed when the mint is unreachable — retryable, not restored", async () => {
      mockFilterUnspentProofs.mockResolvedValue({
        unspent: PROOFS,
        spentCount: 0,
        checked: false,
      });
      const record = makeRecord();
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record)),
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(listBuyerEscrows()).toEqual([]);
      expect(result.unrecoveredEscrows).toEqual([
        { ...infoFor(record), mintUrl: MINT, reason: "mint_unreachable" },
      ]);
    });

    it("reports spent proofs as unrecoverable instead of partially restoring", async () => {
      mockFilterUnspentProofs.mockResolvedValue({
        unspent: [PROOFS[0]],
        spentCount: 1,
        checked: true,
      });
      const record = makeRecord();
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record)),
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(listBuyerEscrows()).toEqual([]);
      expect(result.unrecoveredEscrows).toEqual([
        { ...infoFor(record), mintUrl: MINT, reason: "proofs_spent" },
      ]);
    });

    it("rejects backups whose proofs don't match the escrow metadata", async () => {
      const record = makeRecord();
      // Wrong seller key in the lock vs. the metadata.
      const mismatched = [
        {
          ...PROOFS[0]!,
          secret: JSON.stringify([
            "P2PK",
            {
              nonce: "ef".repeat(16),
              data: "e".repeat(64),
              tags: [["locktime", String(EXPIRES_AT)]],
            },
          ]),
        },
        { ...PROOFS[1]! },
      ] as unknown as Proof[];
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record), mismatched),
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(result.unrecoveredEscrows[0]!.reason).toBe("invalid_backup");
      expect(mockFilterUnspentProofs).not.toHaveBeenCalled();
    });

    it("rejects backups whose proofs don't sum to the committed amount", async () => {
      const record = makeRecord();
      const result = await restoreEscrowsFromProofEvents([
        backupEvent(infoFor(record), [PROOFS[0]!]),
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(result.unrecoveredEscrows[0]!.reason).toBe("invalid_backup");
    });

    it("ignores events without escrow metadata (ordinary wallet backups)", async () => {
      const result = await restoreEscrowsFromProofEvents([
        { mint: MINT, proofs: PROOFS, created_at: 1 },
      ]);
      expect(result.restoredEscrowCount).toBe(0);
      expect(result.unrecoveredEscrows).toEqual([]);
      expect(mockFilterUnspentProofs).not.toHaveBeenCalled();
    });
  });

  describe("describeEscrowBackupWarning", () => {
    it("tells the buyer a permanent encryption failure means no recovery backup", () => {
      const text = describeEscrowBackupWarning("encryption_failed");
      expect(text).toContain("no recovery backup");
      expect(text).toContain("NIP-44");
      expect(text).toContain("safe on this device");
    });

    it("frames transient failures as retrying", () => {
      expect(describeEscrowBackupWarning("publish_failed")).toContain(
        "keep retrying"
      );
      expect(describeEscrowBackupWarning("unavailable")).toContain(
        "keep retrying"
      );
    });
  });

  describe("describeEscrowRestore", () => {
    it("is empty when nothing happened", () => {
      expect(
        describeEscrowRestore({
          restoredEscrowCount: 0,
          restoredEscrowSats: 0,
          unrecoveredEscrows: [],
        })
      ).toBe("");
    });

    it("points unrecoverable escrows at support with order id and expiry", () => {
      const record = makeRecord();
      const text = describeEscrowRestore({
        restoredEscrowCount: 1,
        restoredEscrowSats: 121,
        unrecoveredEscrows: [
          { ...infoFor(record), mintUrl: MINT, reason: "proofs_spent" },
          { ...infoFor(record), mintUrl: MINT, reason: "mint_unreachable" },
        ],
      });
      expect(text).toContain("Restored 1 escrowed payment (121 sats).");
      expect(text).toContain("mint was unreachable");
      expect(text).toContain("contact support before it expires");
      expect(text).toContain(record.orderId);
    });
  });
});
