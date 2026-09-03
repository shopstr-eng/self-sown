import type { NextApiRequest, NextApiResponse } from "next";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";
import handler from "@/pages/api/cashu/escrow/refund";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import {
  attachEscrowPayoutPayload,
  enqueueEscrowAction,
  getEscrowOutboxEntryByEscrowId,
  getEscrowRegistration,
} from "@/utils/db/cashu-escrow-service";
import { validateEscrowPayoutProofs } from "@/utils/cashu/escrow-payout";
import { buildEscrowActionEventTemplate } from "@/utils/cashu/escrow-commitment";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/cashu/escrow-config", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-config");
  return { ...actual, isEscrowEnabled: jest.fn(() => true) };
});
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  attachEscrowPayoutPayload: jest.fn(),
  convertExpiredAwaitingWitnessReleaseToRefund: jest.fn(),
  enqueueEscrowAction: jest.fn(),
  getEscrowOutboxEntryByEscrowId: jest.fn(),
  getEscrowRegistration: jest.fn(),
}));
// The proof validator is unit-tested in escrow-payout tests; here it is a
// seam so the endpoint contract can be tested without mint-shaped fixtures.
jest.mock("@/utils/cashu/escrow-payout", () => ({
  validateEscrowPayoutProofs: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedIsEscrowEnabled = isEscrowEnabled as jest.Mock;
const mockedEnqueue = enqueueEscrowAction as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;
const mockedGetOutbox = getEscrowOutboxEntryByEscrowId as jest.Mock;
const mockedAttach = attachEscrowPayoutPayload as jest.Mock;
const mockedValidate = validateEscrowPayoutProofs as jest.Mock;
const mockedConvertAwaiting: jest.Mock = jest.requireMock(
  "@/utils/db/cashu-escrow-service"
).convertExpiredAwaitingWitnessReleaseToRefund;

const buyerSecret = generateSecretKey();
const BUYER_PK = getPublicKey(buyerSecret);
const ESCROW_ID = `${BUYER_PK}:order-xyz`;

const DUMMY_PROOF = {
  id: "009a1f293253e41e",
  amount: 100,
  secret: "locked-proof-secret",
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

function makeActionEvent(
  escrowId = ESCROW_ID,
  secret: Uint8Array = buyerSecret
): Event {
  return finalizeEvent(
    buildEscrowActionEventTemplate({ action: "refund", escrowId }),
    secret
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    actionEvent: makeActionEvent(),
    payoutProofs: [DUMMY_PROOF],
    ...overrides,
  };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    escrowId: ESCROW_ID,
    buyerPubkey: BUYER_PK,
    sellerPubkey: "d".repeat(64),
    orderId: "order-xyz",
    amountSats: 10_000,
    mintUrl: "https://mint.example",
    arbiterPubkey: null,
    // Expired by default — refund is only offered after the lock expires.
    expiresAt: new Date(Date.now() - 1000),
    status: "locked",
    ...overrides,
  };
}

describe("POST /api/cashu/escrow/refund", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsEscrowEnabled.mockReturnValue(true);
    mockedApplyRateLimit.mockResolvedValue(true);
    mockedGetRegistration.mockResolvedValue(registration());
    mockedEnqueue.mockResolvedValue({ enqueued: true });
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: false,
    });
    mockedAttach.mockResolvedValue(true);
    mockedValidate.mockReturnValue(undefined);
  });

  it("fails closed when escrow is not enabled", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = makeReqRes({}, "GET");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("stops when the rate limiter rejects", async () => {
    mockedApplyRateLimit.mockResolvedValue(false);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing action event", async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("rejects a request without signed payout proofs", async () => {
    const { req, res } = makeReqRes({ actionEvent: makeActionEvent() });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(mockedValidate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects an action event that fails verification", async () => {
    const badEvent = {
      id: "0".repeat(64),
      pubkey: "0".repeat(64),
      sig: "0".repeat(128),
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [],
    };
    const { req, res } = makeReqRes(validBody({ actionEvent: badEvent }));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_action");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("404s when the escrow is unknown", async () => {
    mockedGetRegistration.mockResolvedValue(null);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("escrow_not_found");
  });

  it("rejects when the signer is not the committed buyer", async () => {
    // The verifier binds the signer to the escrow id prefix; this covers the
    // DB-authoritative check (registration names a different buyer).
    mockedGetRegistration.mockResolvedValue(
      registration({ buyerPubkey: "e".repeat(64) })
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("not_buyer");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a refund before the lock expires", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
    mockedGetRegistration.mockResolvedValue(
      registration({ expiresAt: new Date(expiresAtSeconds * 1000) })
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("not_expired");
    expect(res.body.expiresAt).toBe(expiresAtSeconds);
    expect(mockedValidate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects proofs that fail commitment validation", async () => {
    mockedValidate.mockImplementation(() => {
      throw new Error("Escrow refund proof is not signed by the buyer.");
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_proofs");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("enqueues AND attaches the signed refund payload after expiry", async () => {
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      escrowId: ESCROW_ID,
      status: "refund_pending",
      enqueued: true,
      attached: true,
    });
    expect(mockedEnqueue).toHaveBeenCalledWith(ESCROW_ID, "refund");
    expect(mockedValidate).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID }),
      "refund",
      [DUMMY_PROOF]
    );
    expect(mockedAttach).toHaveBeenCalledWith("outbox-1", {
      proofs: [DUMMY_PROOF],
    });
  });

  it("completes the payload-less refund entry the expiry sweep enqueued", async () => {
    // Sweep ran first: the row already exists (pending, no payload), so the
    // enqueue is a no-op — but the buyer's signed proofs MUST still attach,
    // or the refund can never be paid out.
    mockedEnqueue.mockResolvedValue({ enqueued: false });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refund_pending");
    expect(res.body.enqueued).toBe(false);
    expect(res.body.attached).toBe(true);
    expect(mockedAttach).toHaveBeenCalledWith("outbox-1", {
      proofs: [DUMMY_PROOF],
    });
  });

  it("retries the attach once after losing a claim race with the worker", async () => {
    // Worker claims between our read and attach (first attach misses), then
    // fails for lack of payload and the entry returns to pending — the
    // endpoint re-reads and lands the payload on the retry.
    mockedAttach.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refund_pending");
    expect(res.body.attached).toBe(true);
    expect(mockedAttach).toHaveBeenCalledTimes(2);
    expect(mockedGetOutbox).toHaveBeenCalledTimes(2);
  });

  it("reports refund_processing (attached:false) when the entry stays claimed", async () => {
    mockedAttach.mockResolvedValue(false);
    mockedGetOutbox
      .mockResolvedValueOnce({
        outboxId: "outbox-1",
        action: "refund",
        status: "pending",
        payoutOutputs: null,
        payloadAttached: false,
      })
      .mockResolvedValueOnce({
        outboxId: "outbox-1",
        action: "refund",
        status: "processing",
        payoutOutputs: null,
        payloadAttached: false,
      });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refund_processing");
    expect(res.body.attached).toBe(false);
    // No false success: the buyer UI keeps the refund control available.
    expect(mockedAttach).toHaveBeenCalledTimes(1);
  });

  it("reports a refund already claimed by the worker without attaching", async () => {
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "processing",
      payoutOutputs: null,
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refund_processing");
    expect(res.body.attached).toBe(false);
    expect(mockedAttach).not.toHaveBeenCalled();
  });

  it("hands the paid-out refund token back on a completed replay", async () => {
    mockedEnqueue.mockResolvedValue({ enqueued: false });
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "done",
      payoutOutputs: [DUMMY_PROOF],
    });
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refunded");
    expect(typeof res.body.payoutToken).toBe("string");
    expect(res.body.payoutToken.startsWith("cashu")).toBe(true);
    expect(mockedAttach).not.toHaveBeenCalled();
  });

  it("converts an ignored awaiting-witness release so the refund can attach", async () => {
    // Buyer approved a release pre-expiry, the seller never witnessed it,
    // and the lock has now expired: the endpoint atomically converts the
    // stale release to a payload-less refund (a no-op same-action enqueue
    // follows), then attaches the buyer's witnessed proofs as usual.
    mockedConvertAwaiting.mockResolvedValue(true);
    mockedEnqueue.mockResolvedValue({ enqueued: false, outboxId: "outbox-1" });
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: false,
      payoutPayload: null,
    });
    mockedAttach.mockResolvedValue(true);
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(mockedConvertAwaiting).toHaveBeenCalledWith(ESCROW_ID);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("refund_pending");
    expect(res.body.attached).toBe(true);
    expect(mockedAttach).toHaveBeenCalledWith("outbox-1", {
      proofs: [DUMMY_PROOF],
    });
  });

  it("409s on a conflicting pending release", async () => {
    mockedEnqueue.mockRejectedValue(
      new Error("Escrow already has a pending release.")
    );
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("escrow_conflict");
  });

  it("500s on unexpected storage failures", async () => {
    mockedEnqueue.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes(validBody());
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe("internal_error");
  });
});
