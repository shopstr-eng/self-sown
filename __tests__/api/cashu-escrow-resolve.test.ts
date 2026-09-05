import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cashu/escrow/resolve";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  getEscrowArbiterPubkeys,
  isEscrowEnabled,
} from "@/utils/cashu/escrow-config";
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
jest.mock("@/utils/cashu/escrow-config", () => ({
  isEscrowEnabled: jest.fn(() => true),
  getEscrowArbiterPubkeys: jest.fn(),
}));
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
const mockedArbiterAllowlist = getEscrowArbiterPubkeys as jest.Mock;
const mockedVerify = verifyEscrowActionEvent as jest.Mock;
const mockedValidate = validateEscrowPayoutProofs as jest.Mock;
const mockedAttach = attachEscrowPayoutPayload as jest.Mock;
const mockedEnqueue = enqueueEscrowAction as jest.Mock;
const mockedGetOutbox = getEscrowOutboxEntryByEscrowId as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;

const BUYER_PK = "b".repeat(64);
const SELLER_PK = "d".repeat(64);
const ARBITER_PK = "a".repeat(64);
const ESCROW_ID = `${BUYER_PK}:order-xyz`;
const EXPIRES_AT_SECONDS = 1_900_000_000;

const DUMMY_PROOF = {
  id: "009a1f293253e41e",
  amount: 100,
  secret: "locked-proof",
  C: "02" + "cd".repeat(32),
  witness: { signatures: ["ab".repeat(64)] },
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
    payoutProofs: [DUMMY_PROOF],
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
    arbiterPubkey: ARBITER_PK,
    expiresAt: new Date(EXPIRES_AT_SECONDS * 1000),
    status: "locked",
    ...overrides,
  };
}

/** The verified action event as the (mocked) verifier would return it. */
function verifiedAction(action: "release" | "refund" = "refund") {
  return { ok: true, action, escrowId: ESCROW_ID, actorPubkey: ARBITER_PK };
}

function pendingOutbox(action: "release" | "refund" = "refund") {
  return {
    outboxId: "outbox-1",
    escrowId: ESCROW_ID,
    action,
    status: "pending",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedIsEscrowEnabled.mockReturnValue(true);
  mockedApplyRateLimit.mockResolvedValue(true);
  mockedVerify.mockReturnValue(verifiedAction());
  mockedArbiterAllowlist.mockReturnValue(new Set([ARBITER_PK]));
  mockedGetRegistration.mockResolvedValue(registration());
  mockedValidate.mockImplementation(() => {});
  mockedEnqueue.mockResolvedValue({ enqueued: true, outboxId: "outbox-1" });
  mockedGetOutbox.mockResolvedValue(pendingOutbox());
  mockedAttach.mockResolvedValue(true);
});

describe("POST /api/cashu/escrow/resolve", () => {
  it("rejects non-POST methods", async () => {
    const { req, res } = makeReqRes(validBody(), "GET");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("fails closed when escrow is disabled", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
  });

  it("rejects a missing action event", async () => {
    const { req, res } = makeReqRes({ payoutProofs: [DUMMY_PROOF] });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("rejects missing payout proofs", async () => {
    const { req, res } = makeReqRes({
      actionEvent: { content: "{}", tags: [] },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("rejects an invalid action event", async () => {
    mockedVerify.mockReturnValue({ ok: false, error: "bad signature" });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_action");
  });

  it("404s on an unknown escrow", async () => {
    mockedGetRegistration.mockResolvedValue(null);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("escrow_not_found");
  });

  it("rejects resolution on an escrow with no registered arbiter", async () => {
    mockedGetRegistration.mockResolvedValue(
      registration({ arbiterPubkey: null })
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("no_arbiter");
  });

  it("rejects a signer who is not the registered arbiter", async () => {
    mockedVerify.mockReturnValue({
      ...verifiedAction(),
      actorPubkey: BUYER_PK, // a party can never self-resolve
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("not_arbiter");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects an arbiter the operator has removed from the allowlist", async () => {
    mockedArbiterAllowlist.mockReturnValue(new Set(["f".repeat(64)]));
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("arbiter_not_allowlisted");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects proofs that fail payout validation", async () => {
    mockedValidate.mockImplementation(() => {
      throw new Error(
        "Escrow payout proof is not locked to the committed seller."
      );
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_proofs");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("409s on a conflicting pending opposite action", async () => {
    mockedEnqueue.mockRejectedValue(
      new Error(
        "Cannot enqueue a refund: escrow already has a pending release."
      )
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("escrow_conflict");
  });

  it("enqueues an arbiter-directed refund and attaches the payload", async () => {
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      escrowId: ESCROW_ID,
      status: "resolution_pending",
      enqueued: true,
      attached: true,
    });
    expect(mockedEnqueue).toHaveBeenCalledWith(ESCROW_ID, "refund");
    expect(mockedAttach).toHaveBeenCalledWith("outbox-1", {
      proofs: [DUMMY_PROOF],
      stage: "ready",
      directedByArbiter: true,
    });
    // The directed path must reach the validator.
    expect(mockedValidate).toHaveBeenCalledWith(
      expect.objectContaining({ arbiterPubkey: ARBITER_PK }),
      "refund",
      [DUMMY_PROOF],
      undefined,
      { directedByArbiter: true }
    );
  });

  it("enqueues an arbiter-directed release", async () => {
    mockedVerify.mockReturnValue(verifiedAction("release"));
    mockedGetOutbox.mockResolvedValue(pendingOutbox("release"));
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("resolution_pending");
    expect(mockedEnqueue).toHaveBeenCalledWith(ESCROW_ID, "release");
  });

  it("replays a completed resolution with the payout token field", async () => {
    mockedEnqueue.mockResolvedValue({ enqueued: false, outboxId: "outbox-1" });
    mockedGetOutbox.mockResolvedValue({
      ...pendingOutbox(),
      status: "done",
      payoutOutputs: [],
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      escrowId: ESCROW_ID,
      status: "refunded",
      enqueued: false,
    });
    expect(mockedAttach).not.toHaveBeenCalled();
  });

  it("retries the attach once across a worker claim race", async () => {
    mockedAttach.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("resolution_pending");
    expect(mockedAttach).toHaveBeenCalledTimes(2);
  });

  it("reports processing when the worker claimed the entry mid-flight", async () => {
    mockedAttach.mockResolvedValue(false);
    mockedGetOutbox
      .mockResolvedValueOnce(pendingOutbox())
      .mockResolvedValueOnce({ ...pendingOutbox(), status: "processing" });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("resolution_processing");
    expect(res.body.attached).toBe(false);
  });
});
