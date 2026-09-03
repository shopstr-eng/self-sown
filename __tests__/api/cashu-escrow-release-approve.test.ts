import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cashu/escrow/release-approve";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyEscrowActionEvent } from "@/utils/cashu/escrow-commitment";
import { validateEscrowPayoutProofs } from "@/utils/cashu/escrow-payout";
import {
  attachEscrowPayoutPayload,
  enqueueEscrowAction,
  getEscrowOutboxEntryByEscrowId,
  getEscrowRegistration,
} from "@/utils/db/cashu-escrow-service";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/cashu/escrow-config", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-config");
  return { ...actual, isEscrowEnabled: jest.fn(() => true) };
});
jest.mock("@/utils/cashu/escrow-commitment", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-commitment");
  return { ...actual, verifyEscrowActionEvent: jest.fn() };
});
jest.mock("@/utils/cashu/escrow-payout", () => ({
  validateEscrowPayoutProofs: jest.fn(),
}));
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  attachEscrowPayoutPayload: jest.fn(),
  enqueueEscrowAction: jest.fn(),
  getEscrowOutboxEntryByEscrowId: jest.fn(),
  getEscrowRegistration: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedIsEscrowEnabled = isEscrowEnabled as jest.Mock;
const mockedVerify = verifyEscrowActionEvent as jest.Mock;
const mockedValidate = validateEscrowPayoutProofs as jest.Mock;
const mockedAttach = attachEscrowPayoutPayload as jest.Mock;
const mockedEnqueue = enqueueEscrowAction as jest.Mock;
const mockedGetOutbox = getEscrowOutboxEntryByEscrowId as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;

const BUYER_PK = "b".repeat(64);
const SELLER_PK = "d".repeat(64);
const ESCROW_ID = `${BUYER_PK}:order-xyz`;
const EXPIRES_AT_SECONDS = 1_900_000_000; // far future: pre-expiry

const DUMMY_PROOF = {
  id: "009a1f293253e41e",
  amount: 100,
  secret: "locked-proof",
  C: "02" + "cd".repeat(32),
};

function makeReqRes(body?: any, method = "POST") {
  const req = {
    method,
    body,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return {
    req,
    res: res as NextApiResponse & { statusCode: number; body: any },
  };
}

function validBody() {
  return {
    actionEvent: { content: "{}", tags: [["d", ESCROW_ID]] },
    proofs: [DUMMY_PROOF],
  };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    escrowId: ESCROW_ID,
    buyerPubkey: BUYER_PK,
    sellerPubkey: SELLER_PK,
    orderId: "order-xyz",
    amountSats: 10_000,
    mintUrl: "https://mint.example",
    arbiterPubkey: null,
    expiresAt: new Date(EXPIRES_AT_SECONDS * 1000),
    status: "locked",
    ...overrides,
  };
}

describe("POST /api/cashu/escrow/release-approve", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsEscrowEnabled.mockReturnValue(true);
    mockedApplyRateLimit.mockResolvedValue(true);
    mockedVerify.mockReturnValue({
      ok: true,
      action: "release",
      escrowId: ESCROW_ID,
      actorPubkey: BUYER_PK,
    });
    mockedValidate.mockReturnValue(undefined);
    mockedEnqueue.mockResolvedValue({ enqueued: true, outboxId: "outbox-1" });
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "release",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: false,
      payoutPayload: null,
    });
    mockedAttach.mockResolvedValue(true);
    mockedGetRegistration.mockResolvedValue(registration());
  });

  it("fails closed when escrow is not enabled", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = makeReqRes(validBody(), "GET");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("400s without the signed action event or the raw proofs", async () => {
    for (const body of [
      undefined,
      { proofs: [DUMMY_PROOF] },
      { actionEvent: { content: "{}", tags: [] } },
      { ...validBody(), proofs: [] },
    ]) {
      const { req, res } = makeReqRes(body);
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });

  it("400s when the action event fails verification", async () => {
    mockedVerify.mockReturnValue({ ok: false, error: "bad signature" });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_action");
  });

  it("404s for an unknown escrow", async () => {
    mockedGetRegistration.mockResolvedValue(null);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("escrow_not_found");
  });

  it("403s when the signer is not the committed buyer", async () => {
    mockedVerify.mockReturnValue({
      ok: true,
      action: "release",
      escrowId: ESCROW_ID,
      actorPubkey: SELLER_PK,
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("not_buyer");
  });

  it("409s once the lock has expired (refunds own that window)", async () => {
    mockedGetRegistration.mockResolvedValue(
      registration({ expiresAt: new Date(Date.now() - 60_000) })
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("expired");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("400s when the proofs structurally mismatch the commitment", async () => {
    mockedValidate.mockImplementation(() => {
      throw new Error(
        "Escrow payout proof is not locked to the committed seller."
      );
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_proofs");
  });

  it("enqueues and stores the raw proofs awaiting the seller's witness", async () => {
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("release_pending");
    expect(res.body.attached).toBe(true);
    expect(mockedEnqueue).toHaveBeenCalledWith(ESCROW_ID, "release");
    expect(mockedAttach).toHaveBeenCalledWith("outbox-1", {
      proofs: [DUMMY_PROOF],
      stage: "awaiting_seller_witness",
    });
    // Structural pre-check only — the seller's witness comes later.
    expect(mockedValidate).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID }),
      "release",
      [DUMMY_PROOF],
      undefined,
      { requireWitness: false }
    );
  });

  it("replays a completed release with the payout token", async () => {
    mockedEnqueue.mockResolvedValue({ enqueued: false, outboxId: "outbox-1" });
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "release",
      status: "done",
      payoutOutputs: [
        {
          id: "009a1f293253e41e",
          amount: 100,
          secret: "seller-locked-output",
          C: "02" + "cd".repeat(32),
        },
      ],
      payloadAttached: true,
      payoutPayload: { proofs: [DUMMY_PROOF], stage: "ready" },
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("released");
    expect(typeof res.body.payoutToken).toBe("string");
    expect(mockedAttach).not.toHaveBeenCalled();
  });

  it("409s on a conflicting pending refund", async () => {
    mockedEnqueue.mockRejectedValue(
      new Error(
        "Cannot enqueue a release: escrow already has a pending refund."
      )
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("escrow_conflict");
  });
});
