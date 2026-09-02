import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cashu/escrow/status";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import {
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
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  getEscrowOutboxEntryByEscrowId: jest.fn(),
  getEscrowRegistration: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedIsEscrowEnabled = isEscrowEnabled as jest.Mock;
const mockedGetRegistration = getEscrowRegistration as jest.Mock;
const mockedGetOutbox = getEscrowOutboxEntryByEscrowId as jest.Mock;

const BUYER_PK = "b".repeat(64);
const ESCROW_ID = `${BUYER_PK}:order-xyz`;
const EXPIRES_AT_SECONDS = 1_900_000_000;

function makeReqRes(query: Record<string, unknown> = {}, method = "GET") {
  const req = {
    method,
    query,
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
  return { req, res: res as NextApiResponse & { statusCode: number; body: any } };
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
    expiresAt: new Date(EXPIRES_AT_SECONDS * 1000),
    status: "locked",
    ...overrides,
  };
}

describe("GET /api/cashu/escrow/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsEscrowEnabled.mockReturnValue(true);
    mockedApplyRateLimit.mockResolvedValue(true);
    mockedGetRegistration.mockResolvedValue(registration());
    mockedGetOutbox.mockResolvedValue(null);
  });

  it("fails closed when escrow is not enabled", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
  });

  it("rejects non-GET methods", async () => {
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID }, "POST");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("stops when the rate limiter rejects", async () => {
    mockedApplyRateLimit.mockResolvedValue(false);
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(mockedGetRegistration).not.toHaveBeenCalled();
  });

  it("rejects a missing or malformed escrow id", async () => {
    for (const query of [{}, { escrowId: "not-an-id" }, { escrowId: 42 }]) {
      const { req, res } = makeReqRes(query);
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });

  it("404s when the escrow is unknown", async () => {
    mockedGetRegistration.mockResolvedValue(null);
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("escrow_not_found");
  });

  it("returns status and expiry with no pending action", async () => {
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      escrowId: ESCROW_ID,
      status: "locked",
      expiresAt: EXPIRES_AT_SECONDS,
      pendingAction: null,
      payloadAttached: false,
      releaseAwaitingSeller: false,
      mintUrl: "https://mint.example",
    });
  });

  it("surfaces a pending outbox action, distinguishing payload-less entries", async () => {
    // The expiry sweep auto-enqueues refunds with NO payload; the buyer UI
    // must keep the refund control available until it is attached.
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: false,
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pendingAction).toBe("refund");
    expect(res.body.payloadAttached).toBe(false);
    expect(res.body.payoutToken).toBeUndefined();
  });

  it("reports payloadAttached once the buyer's proofs landed", async () => {
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: true,
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.payloadAttached).toBe(true);
  });

  it("hides completed outbox actions", async () => {
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "done",
      payoutOutputs: null,
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pendingAction).toBeNull();
    expect(res.body.payoutToken).toBeUndefined();
  });

  it("delivers the paid-out refund token to the buyer", async () => {
    mockedGetRegistration.mockResolvedValue(
      registration({ status: "refunded" })
    );
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "refund",
      status: "done",
      payoutOutputs: [
        {
          id: "009a1f293253e41e",
          amount: 100,
          secret: "buyer-locked-output",
          C: "02" + "cd".repeat(32),
        },
      ],
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pendingAction).toBeNull();
    expect(typeof res.body.payoutToken).toBe("string");
    expect(res.body.payoutToken.startsWith("cashu")).toBe(true);
  });

  it("serves a buyer-approved release's raw proofs while awaiting the seller", async () => {
    const rawProofs = [
      {
        id: "009a1f293253e41e",
        amount: 100,
        secret: "locked-proof",
        C: "02" + "cd".repeat(32),
      },
    ];
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "release",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: true,
      payoutPayload: { proofs: rawProofs, stage: "awaiting_seller_witness" },
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pendingAction).toBe("release");
    expect(res.body.releaseAwaitingSeller).toBe(true);
    expect(res.body.releaseProofs).toEqual(rawProofs);
  });

  it("withholds raw proofs once the seller's witnessed payload is ready", async () => {
    mockedGetOutbox.mockResolvedValue({
      outboxId: "outbox-1",
      action: "release",
      status: "pending",
      payoutOutputs: null,
      payloadAttached: true,
      payoutPayload: { proofs: [{ id: "x" }], stage: "ready" },
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.releaseAwaitingSeller).toBe(false);
    expect(res.body.releaseProofs).toBeUndefined();
  });

  it("delivers the paid-out RELEASE token (seller-locked, useless to others)", async () => {
    mockedGetRegistration.mockResolvedValue(
      registration({ status: "released" })
    );
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
    });
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pendingAction).toBeNull();
    expect(typeof res.body.payoutToken).toBe("string");
    expect(res.body.payoutToken.startsWith("cashu")).toBe(true);
  });

  it("500s on unexpected storage failures", async () => {
    mockedGetRegistration.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes({ escrowId: ESCROW_ID });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe("internal_error");
  });
});
