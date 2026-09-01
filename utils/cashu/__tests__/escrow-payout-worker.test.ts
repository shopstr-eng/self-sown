// Worker mechanics tests: claim fencing, finalize vs release-on-failure,
// expiry conversion, prepared-output persistence, and stale-claim recovery.
// The DB service and the mint executor are mocked — the service's own SQL
// semantics are covered in utils/db/__tests__/cashu-escrow-service.test.ts
// and the executor's mint discipline in utils/cashu/__tests__/escrow-payout.test.ts.

import {
  processEscrowOutboxEntry,
  runEscrowPayoutSweep,
} from "@/utils/cashu/escrow-payout-worker";
import {
  claimEscrowOutboxEntry,
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

jest.mock("@/utils/db/cashu-escrow-service", () => ({
  claimEscrowOutboxEntry: jest.fn(),
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
const mockedEnqueue = enqueueEscrowAction as jest.Mock;
const mockedFinalize = finalizeEscrowOutboxEntry as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;
const mockedListExpired = listExpiredLockedEscrows as jest.Mock;
const mockedListPending = listPendingEscrowOutboxEntries as jest.Mock;
const mockedRecover = recoverStaleEscrowOutboxClaims as jest.Mock;
const mockedRelease = releaseEscrowOutboxClaim as jest.Mock;
const mockedSave = saveEscrowPreparedOutputs as jest.Mock;
const mockedEnabled = isEscrowEnabled as jest.Mock;

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
