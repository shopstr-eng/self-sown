// Worker mechanics tests: claim fencing, finalize vs release-on-failure,
// expiry conversion, prepared-output persistence, and stale-claim recovery.
// The DB service and the mint executor are mocked — the service's own SQL
// semantics are covered in utils/db/__tests__/cashu-escrow-service.test.ts
// and the executor's mint discipline in utils/cashu/__tests__/escrow-payout.test.ts.

import {
  createP2PKsecret,
  OutputData,
  signP2PKProof,
  type Proof,
  type SerializedOutputData,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  processEscrowOutboxEntry,
  runEscrowPayoutSweep,
} from "@/utils/cashu/escrow-payout-worker";
import {
  executeEscrowPayout,
  type EscrowPayoutMintApi,
  type EscrowPayoutMintWallet,
} from "@/utils/cashu/escrow-payout";
import {
  claimEscrowOutboxEntry,
  convertExpiredAwaitingWitnessReleaseToRefund,
  convertExpiredReleaseToRefund,
  enqueueEscrowAction,
  finalizeEscrowOutboxEntry,
  getEscrowRegistration,
  listExpiredLockedEscrows,
  listPendingEscrowOutboxEntries,
  recoverStaleEscrowOutboxClaims,
  releaseEscrowOutboxClaim,
  saveEscrowPreparedOutputs,
} from "@/utils/db/cashu-escrow-service";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { notifyEscrowPayoutFinalized } from "@/utils/cashu/escrow-payout-notify";

jest.mock("@/utils/cashu/escrow-payout-notify", () => ({
  notifyEscrowPayoutFinalized: jest.fn(),
}));
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  claimEscrowOutboxEntry: jest.fn(),
  convertExpiredAwaitingWitnessReleaseToRefund: jest.fn(),
  convertExpiredReleaseToRefund: jest.fn(),
  enqueueEscrowAction: jest.fn(),
  finalizeEscrowOutboxEntry: jest.fn(),
  getEscrowRegistration: jest.fn(),
  listExpiredLockedEscrows: jest.fn(),
  listPendingEscrowOutboxEntries: jest.fn(),
  recoverStaleEscrowOutboxClaims: jest.fn(),
  releaseEscrowOutboxClaim: jest.fn(),
  saveEscrowPreparedOutputs: jest.fn(),
}));
jest.mock("@/utils/cashu/escrow-config", () => ({
  isEscrowEnabled: jest.fn(() => true),
}));

const mockedClaim = claimEscrowOutboxEntry as jest.Mock;
const mockedConvert = convertExpiredReleaseToRefund as jest.Mock;
const mockedConvertAwaiting =
  convertExpiredAwaitingWitnessReleaseToRefund as jest.Mock;
const mockedEnqueue = enqueueEscrowAction as jest.Mock;
const mockedFinalize = finalizeEscrowOutboxEntry as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;
const mockedListExpired = listExpiredLockedEscrows as jest.Mock;
const mockedListPending = listPendingEscrowOutboxEntries as jest.Mock;
const mockedRecover = recoverStaleEscrowOutboxClaims as jest.Mock;
const mockedRelease = releaseEscrowOutboxClaim as jest.Mock;
const mockedSave = saveEscrowPreparedOutputs as jest.Mock;
const mockedEnabled = isEscrowEnabled as jest.Mock;
const mockedNotify = notifyEscrowPayoutFinalized as jest.Mock;

const REGISTRATION = {
  escrowId: "buyer:order-1",
  buyerPubkey: "a".repeat(64),
  sellerPubkey: "b".repeat(64),
  orderId: "order-1",
  amountSats: 5_000,
  mintUrl: "https://mint.example",
  arbiterPubkey: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  status: "locked" as const,
};

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    outboxId: "buyer:order-1",
    escrowId: "buyer:order-1",
    action: "release",
    status: "processing",
    attempts: 1,
    claimToken: "token-1",
    payoutPayload: { proofs: [{ secret: "s" }] },
    preparedOutputs: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedEnabled.mockReturnValue(true);
  mockedGetRegistration.mockResolvedValue(REGISTRATION);
  mockedRecover.mockResolvedValue(0);
  mockedListExpired.mockResolvedValue([]);
  mockedListPending.mockResolvedValue([]);
  mockedRelease.mockResolvedValue(true);
  mockedSave.mockResolvedValue(true);
  mockedConvert.mockResolvedValue(true);
  mockedNotify.mockResolvedValue(true);
});

describe("processEscrowOutboxEntry", () => {
  it("claims, pays out, and finalizes with the claim fencing token", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const outputs = [{ secret: "out", amount: 4999 }];
    const executePayout: jest.Mock = jest.fn(async () => ({ outputs }));

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result).toEqual({ outboxId: "buyer:order-1", status: "processed" });
    expect(executePayout).toHaveBeenCalledWith(
      REGISTRATION,
      "release",
      claimed().payoutPayload,
      expect.objectContaining({
        nowSeconds: expect.any(Number),
        preparedOutputs: undefined,
        persistPreparedOutputs: expect.any(Function),
      })
    );
    expect(mockedFinalize).toHaveBeenCalledWith(
      "buyer:order-1",
      "token-1",
      outputs
    );
    expect(mockedRelease).not.toHaveBeenCalled();
    // Post-finalize: the payee is notified exactly once with the resolution.
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith(REGISTRATION, "release");
  });

  it("notifies the buyer after a finalized refund", async () => {
    mockedClaim.mockResolvedValue(claimed({ action: "refund" }));
    const executePayout: jest.Mock = jest.fn(async () => ({
      outputs: [{ s: 1 }],
    }));

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("processed");
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith(REGISTRATION, "refund");
  });

  it("still reports processed when the payout notification fails", async () => {
    // The DM is best-effort and isolated: a notification failure must never
    // mark the finalized payout failed or re-queue it.
    mockedClaim.mockResolvedValue(claimed());
    mockedNotify.mockRejectedValue(new Error("relays unreachable"));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    const executePayout: jest.Mock = jest.fn(async () => ({
      outputs: [{ secret: "out" }],
    }));

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result).toEqual({ outboxId: "buyer:order-1", status: "processed" });
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
    expect(mockedRelease).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does NOT notify when the payout fails — only finalization notifies", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const executePayout = jest.fn(async () => {
      throw new Error("mint unreachable");
    });

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("failed");
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("does NOT notify on an expiry conversion — nothing was paid out", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const executePayout = jest.fn();

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
      now: new Date(REGISTRATION.expiresAt.getTime() + 1_000),
    });

    expect(result.status).toBe("converted");
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("persists prepared outputs under the claim fencing token before paying", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const prepared = [{ blindedMessage: { amount: "4", id: "k", B_: "ab" } }];
    const executePayout: jest.Mock = jest.fn(
      async (_reg: any, _action: any, _payload: any, options: any) => {
        await options.persistPreparedOutputs(prepared);
        return { outputs: [{ secret: "out" }] };
      }
    );

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("processed");
    expect(mockedSave).toHaveBeenCalledWith("buyer:order-1", "token-1", prepared);
  });

  it("aborts the payment when the claim was lost before persisting outputs", async () => {
    mockedClaim.mockResolvedValue(claimed());
    mockedSave.mockResolvedValue(false); // fencing token no longer matches
    const executePayout: jest.Mock = jest.fn(
      async (_reg: any, _action: any, _payload: any, options: any) => {
        await options.persistPreparedOutputs([]);
        return { outputs: [] };
      }
    );

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("failed");
    expect((result as any).error).toMatch(/Claim lost/);
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockedRelease).toHaveBeenCalledWith(
      "buyer:order-1",
      "token-1",
      expect.stringMatching(/Claim lost/)
    );
  });

  it("converts a release claimed after expiry into a refund instead of paying", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const executePayout = jest.fn();
    const afterExpiry = new Date(REGISTRATION.expiresAt.getTime() + 1_000);

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
      now: afterExpiry,
    });

    expect(result).toEqual({ outboxId: "buyer:order-1", status: "converted" });
    expect(mockedConvert).toHaveBeenCalledWith(
      "buyer:order-1",
      "token-1",
      afterExpiry
    );
    expect(executePayout).not.toHaveBeenCalled();
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("skips when the claim is reclaimed during expiry conversion", async () => {
    mockedClaim.mockResolvedValue(claimed());
    mockedConvert.mockResolvedValue(false);
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    const executePayout = jest.fn();

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
      now: new Date(REGISTRATION.expiresAt.getTime() + 1_000),
    });

    expect(result.status).toBe("skipped");
    expect(executePayout).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does NOT convert a refund claimed after expiry — it pays", async () => {
    mockedClaim.mockResolvedValue(claimed({ action: "refund" }));
    const executePayout: jest.Mock = jest.fn(async () => ({
      outputs: [{ s: 1 }],
    }));

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
      now: new Date(REGISTRATION.expiresAt.getTime() + 1_000),
    });

    expect(result.status).toBe("processed");
    expect(mockedConvert).not.toHaveBeenCalled();
    expect(executePayout).toHaveBeenCalled();
  });

  it("releases the claim with the error when the payout fails", async () => {
    mockedClaim.mockResolvedValue(claimed());
    const executePayout = jest.fn(async () => {
      throw new Error("mint unreachable");
    });

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result).toEqual({
      outboxId: "buyer:order-1",
      status: "failed",
      error: "mint unreachable",
    });
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockedRelease).toHaveBeenCalledWith(
      "buyer:order-1",
      "token-1",
      "mint unreachable"
    );
  });

  it("skips entries already claimed by another worker", async () => {
    mockedClaim.mockResolvedValue(null);
    const executePayout = jest.fn();

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("skipped");
    expect(executePayout).not.toHaveBeenCalled();
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("refuses to pay out an escrow that is no longer locked", async () => {
    mockedClaim.mockResolvedValue(claimed());
    mockedGetRegistration.mockResolvedValue({
      ...REGISTRATION,
      status: "released",
    });
    const executePayout = jest.fn();

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("failed");
    expect((result as any).error).toMatch(/already released/);
    expect(executePayout).not.toHaveBeenCalled();
    expect(mockedRelease).toHaveBeenCalled();
  });

  it("does not throw when the claim was reclaimed before failure recording", async () => {
    mockedClaim.mockResolvedValue(claimed());
    mockedRelease.mockResolvedValue(false); // fencing token no longer matches
    const executePayout = jest.fn(async () => {
      throw new Error("boom");
    });
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout,
    });

    expect(result.status).toBe("failed");
    consoleSpy.mockRestore();
  });

  it("records a NUT-09-recovered payout for delivery identically to a first-attempt payout", async () => {
    // Composition test across the delivery chain: an earlier attempt crashed
    // after the mint swapped the inputs but before finalizing. The retry
    // finds every input SPENT, reconstructs the payee-locked proofs from the
    // persisted prepared outputs via the mint's /restore endpoint, and the
    // worker finalizes with them — so the payee's delivery path (the
    // payout_outputs recorded here, served by the status endpoint) is
    // identical to a first-attempt payout. Uses the REAL executor with real
    // signed proofs; only the mint network calls are faked.
    const sellerSecret = generateSecretKey();
    const buyerSecret = generateSecretKey();
    const sellerPub = getPublicKey(sellerSecret);
    const buyerPub = getPublicKey(buyerSecret);
    const sellerPriv = Buffer.from(sellerSecret).toString("hex");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const locktime = Math.floor(expiresAt.getTime() / 1000);
    const keysetId = "009a1f293253e41e";

    mockedGetRegistration.mockResolvedValue({
      ...REGISTRATION,
      buyerPubkey: buyerPub,
      sellerPubkey: sellerPub,
      expiresAt,
    });

    const proof = {
      amount: 5_000,
      id: keysetId,
      secret: createP2PKsecret(sellerPub, [
        ["locktime", String(locktime)],
        ["refund", buyerPub],
      ]),
      C: `02${getPublicKey(generateSecretKey())}`,
    } as unknown as Proof;
    const signedProof = signP2PKProof(proof, sellerPriv);

    // Prepared payee-locked outputs persisted by the crashed attempt.
    const preparedOutput = OutputData.createSingleP2PKData(
      { pubkey: sellerPub },
      4,
      keysetId
    );
    const prepared: SerializedOutputData[] = [
      OutputData.serialize(preparedOutput),
    ];

    mockedClaim.mockResolvedValue(
      claimed({
        payoutPayload: { proofs: [signedProof] },
        preparedOutputs: prepared,
      })
    );

    const validPoint = () => `02${getPublicKey(generateSecretKey())}`;
    const wallet: EscrowPayoutMintWallet = {
      checkProofsStates: jest.fn(async () => [{ state: "SPENT" }]) as any,
      prepareSwapToReceive: jest.fn() as any,
      completeSwap: jest.fn() as any,
    };
    const mintApi: EscrowPayoutMintApi = {
      getKeys: jest.fn(async () => ({
        keysets: [{ id: keysetId, unit: "sat", keys: { "4": validPoint() } }],
      })) as any,
      restore: jest.fn(async ({ outputs }: any) => ({
        outputs,
        signatures: outputs.map((o: any) => ({
          id: o.id,
          amount: o.amount,
          C_: validPoint(),
        })),
      })) as any,
    };

    const result = await processEscrowOutboxEntry("buyer:order-1", {
      executePayout: (registration, action, payload, options) =>
        executeEscrowPayout(registration, action, payload, {
          ...options,
          walletFactory: () => wallet,
          mintApiFactory: () => mintApi,
        }),
    });

    expect(result).toEqual({ outboxId: "buyer:order-1", status: "processed" });
    // Recovery never re-pays: no second swap at the mint.
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(wallet.completeSwap).not.toHaveBeenCalled();
    expect(mintApi.restore).toHaveBeenCalledTimes(1);
    // The recovered payee-locked proofs are exactly what finalize records —
    // byte-identical delivery to a first-attempt payout.
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
    const [finalizeId, finalizeToken, recordedOutputs] =
      mockedFinalize.mock.calls[0]!;
    expect(finalizeId).toBe("buyer:order-1");
    expect(finalizeToken).toBe("token-1");
    expect(recordedOutputs).toHaveLength(1);
    expect(recordedOutputs[0].secret).toBe(
      Buffer.from(preparedOutput.secret).toString("utf-8")
    );
    expect(mockedRelease).not.toHaveBeenCalled();
  });
});

describe("runEscrowPayoutSweep", () => {
  it("is a no-op unless escrow is enabled and configured", async () => {
    mockedEnabled.mockReturnValue(false);

    const summary = await runEscrowPayoutSweep();

    expect(summary.skipped).toBe(true);
    expect(mockedRecover).not.toHaveBeenCalled();
    expect(mockedListExpired).not.toHaveBeenCalled();
    expect(mockedListPending).not.toHaveBeenCalled();
  });

  it("recovers stale claims every sweep", async () => {
    mockedRecover.mockResolvedValue(2);

    const summary = await runEscrowPayoutSweep();

    expect(mockedRecover).toHaveBeenCalledTimes(1);
    expect(summary.recovered).toBe(2);
  });

  it("enqueues refunds for expired locked escrows", async () => {
    mockedListExpired.mockResolvedValue([
      { escrowId: "b:o1" },
      { escrowId: "b:o2" },
    ]);
    mockedEnqueue.mockResolvedValue({ enqueued: true, outboxId: "x" });

    const summary = await runEscrowPayoutSweep();

    expect(mockedEnqueue).toHaveBeenCalledWith("b:o1", "refund");
    expect(mockedEnqueue).toHaveBeenCalledWith("b:o2", "refund");
    expect(summary.refundsEnqueued).toBe(2);
  });

  it("converts an ignored awaiting-witness release before enqueueing the expiry refund", async () => {
    // Buyer approved a release pre-expiry, the seller never witnessed it,
    // and the lock expired: the sweep atomically converts the stale release
    // to a payload-less pending refund (the claim guard can never drain that
    // stage), so seller inaction never blocks the buyer's refund.
    mockedListExpired.mockResolvedValue([
      { escrowId: "buyer:order-1" },
      { escrowId: "buyer:order-2" },
    ]);
    mockedConvertAwaiting.mockResolvedValue(true);
    mockedEnqueue.mockResolvedValue({ enqueued: false, outboxId: "x" });
    await runEscrowPayoutSweep();
    expect(mockedConvertAwaiting).toHaveBeenCalledWith("buyer:order-1");
    expect(mockedConvertAwaiting).toHaveBeenCalledWith("buyer:order-2");
    // Conversion runs BEFORE the enqueue for each expired escrow.
    expect(
      mockedConvertAwaiting.mock.invocationCallOrder[0]!
    ).toBeLessThan(mockedEnqueue.mock.invocationCallOrder[0]!);
  });

  it("keeps sweeping when one refund enqueue throws (e.g. release already pending)", async () => {
    mockedListExpired.mockResolvedValue([
      { escrowId: "b:o1" },
      { escrowId: "b:o2" },
    ]);
    mockedEnqueue
      .mockRejectedValueOnce(new Error("already has a pending release"))
      .mockResolvedValueOnce({ enqueued: true, outboxId: "b:o2" });
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const summary = await runEscrowPayoutSweep();

    expect(summary.refundsEnqueued).toBe(1);
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it("drains pending entries and reports per-entry failures without blocking the batch", async () => {
    mockedListPending.mockResolvedValue([
      { outboxId: "b:o1" },
      { outboxId: "b:o2" },
      { outboxId: "b:o3" },
    ]);
    mockedClaim
      .mockResolvedValueOnce(claimed({ outboxId: "b:o1", escrowId: "b:o1" }))
      .mockResolvedValueOnce(claimed({ outboxId: "b:o2", escrowId: "b:o2" }))
      .mockResolvedValueOnce(null); // o3 held by another worker
    const executePayout = jest
      .fn()
      .mockResolvedValueOnce({ outputs: [{ secret: "x" }] })
      .mockRejectedValueOnce(new Error("mint 500"));

    const summary = await runEscrowPayoutSweep({ executePayout });

    expect(summary.processed).toBe(1);
    expect(summary.failed).toEqual([{ outboxId: "b:o2", error: "mint 500" }]);
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
    expect(mockedRelease).toHaveBeenCalledTimes(1);
  });

  it("isolates a claim-level crash so the rest of the batch still drains", async () => {
    mockedListPending.mockResolvedValue([
      { outboxId: "b:o1" },
      { outboxId: "b:o2" },
    ]);
    mockedClaim
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(claimed({ outboxId: "b:o2", escrowId: "b:o2" }));
    const executePayout: jest.Mock = jest.fn(async () => ({
      outputs: [{ s: 1 }],
    }));

    const summary = await runEscrowPayoutSweep({ executePayout });

    expect(summary.failed).toEqual([{ outboxId: "b:o1", error: "db blip" }]);
    expect(summary.processed).toBe(1);
  });
});
